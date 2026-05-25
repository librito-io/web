import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import { PUBLIC_SUPABASE_URL } from "$env/static/public";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import {
  realtimeTokenLimiter,
  realtimeTokenUserLimiter,
  enforceRateLimits,
} from "$lib/server/ratelimit";
import {
  mintRealtimeToken,
  getRealtimeConnectionInfo,
  type RealtimeSigningJwk,
} from "$lib/server/realtime";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { logger } from "$lib/server/log";
import * as Sentry from "@sentry/sveltekit";

export const POST: RequestHandler = async ({ request }) => {
  const supabase = createAdminClient();

  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    return authErrorResponse(authResult.error);
  }

  const { device } = authResult;

  // Single env var: full JWK JSON of the Supabase standby signing key.
  // Dynamic env (vs static) lets self-hosters deploy without it set; the
  // route returns 503 instead of breaking the build.
  const rawJwk = env.LIBRITO_JWT_PRIVATE_KEY_JWK;
  if (!rawJwk) {
    logger().error(
      { event: "realtime.token_disabled", hasPrivateKey: false },
      "realtime.token_disabled",
    );
    return jsonError(
      503,
      "realtime_disabled",
      "Realtime token mint is not configured on this deployment",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJwk);
  } catch (err) {
    logger().error(
      {
        event: "realtime.jwk_parse_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "realtime.jwk_parse_failed",
    );
    Sentry.captureException(err);
    await Sentry.flush(2000);
    return jsonError(500, "server_error", "Failed to mint Realtime token");
  }

  // Valid-JSON-but-wrong-shape JWK (missing `d`, RSA instead of EC, ES384,
  // etc.) would otherwise reach importJWK in mintRealtimeToken and surface
  // as an opaque crypto error mapped to a generic 500 server_error —
  // indistinguishable in Sentry from a transient signing failure. Split
  // here so config drift is loud (server_misconfigured) and operationally
  // distinct from runtime crypto failures.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>).kty !== "EC" ||
    (parsed as Record<string, unknown>).alg !== "ES256" ||
    typeof (parsed as Record<string, unknown>).d !== "string"
  ) {
    logger().error(
      { event: "realtime.jwk_shape_invalid" },
      "realtime.jwk_shape_invalid",
    );
    return jsonError(
      500,
      "server_misconfigured",
      "Invalid LIBRITO_JWT_PRIVATE_KEY_JWK shape",
    );
  }
  const privateJwk = parsed as RealtimeSigningJwk;

  const limited = await enforceRateLimits(
    [
      { limiter: realtimeTokenLimiter, key: device.id },
      { limiter: realtimeTokenUserLimiter, key: device.userId },
    ],
    "Too many realtime token requests",
  );
  if (limited) return limited;

  try {
    const { token, expiresIn } = await mintRealtimeToken({
      userId: device.userId,
      deviceId: device.id,
      privateJwk,
      supabaseUrl: PUBLIC_SUPABASE_URL,
    });

    logger().info(
      {
        event: "realtime.token_issued",
        userId: device.userId,
        deviceId: device.id,
        expiresIn,
      },
      "realtime.token_issued",
    );

    const { realtimeUrl, anonKey } = getRealtimeConnectionInfo();
    return jsonSuccess({ token, expiresIn, realtimeUrl, anonKey });
  } catch (err) {
    logger().error(
      {
        event: "realtime.token_mint_failed",
        userId: device.userId,
        deviceId: device.id,
        error: String(err),
      },
      "realtime.token_mint_failed",
    );
    return jsonError(500, "server_error", "Failed to mint Realtime token");
  }
};
