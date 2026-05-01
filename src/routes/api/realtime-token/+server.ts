import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import { PUBLIC_SUPABASE_URL } from "$env/static/public";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import {
  realtimeTokenLimiter,
  realtimeTokenUserLimiter,
  legacySafeLimit,
} from "$lib/server/ratelimit";
import {
  mintRealtimeToken,
  getRealtimeConnectionInfo,
  type RealtimeSigningJwk,
} from "$lib/server/realtime";
import { jsonError, jsonSuccess } from "$lib/server/errors";

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
    console.error("realtime.token_disabled", { hasPrivateKey: false });
    return jsonError(
      503,
      "realtime_disabled",
      "Realtime token mint is not configured on this deployment",
    );
  }

  let privateJwk: RealtimeSigningJwk;
  try {
    privateJwk = JSON.parse(rawJwk) as RealtimeSigningJwk;
  } catch {
    console.error("realtime.jwk_parse_failed");
    return jsonError(500, "server_error", "Failed to mint Realtime token");
  }

  const [perDevice, perUser] = await Promise.all([
    legacySafeLimit(realtimeTokenLimiter, device.id, "realtime:token"),
    legacySafeLimit(
      realtimeTokenUserLimiter,
      device.userId,
      "realtime:token:user",
    ),
  ]);
  if (!perDevice.success || !perUser.success) {
    const reset = Math.max(perDevice.reset, perUser.reset);
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(
      429,
      "rate_limited",
      "Too many realtime token requests",
      retryAfter,
    );
  }

  try {
    const { token, expiresIn } = await mintRealtimeToken({
      userId: device.userId,
      deviceId: device.id,
      privateJwk,
      supabaseUrl: PUBLIC_SUPABASE_URL,
    });

    console.info("realtime.token_issued", {
      userId: device.userId,
      deviceId: device.id,
      expiresIn,
    });

    const { realtimeUrl, anonKey } = getRealtimeConnectionInfo();
    return jsonSuccess({ token, expiresIn, realtimeUrl, anonKey });
  } catch (err) {
    console.error("realtime.token_mint_failed", {
      userId: device.userId,
      deviceId: device.id,
      error: String(err),
    });
    return jsonError(500, "server_error", "Failed to mint Realtime token");
  }
};
