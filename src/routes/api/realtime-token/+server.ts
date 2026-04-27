import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import {
  realtimeTokenLimiter,
  realtimeTokenUserLimiter,
} from "$lib/server/ratelimit";
import {
  mintRealtimeToken,
  getRealtimeConnectionInfo,
} from "$lib/server/realtime";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({ request }) => {
  const supabase = createAdminClient();

  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    return authErrorResponse(authResult.error);
  }

  const { device } = authResult;

  // Read JWT signing config at request time. Dynamic env (vs static) lets
  // self-hosters deploy without these set; the route fails loudly with 503
  // instead of breaking the build. Required to mint Realtime tokens.
  const privateKeyPem = env.LIBRITO_JWT_PRIVATE_KEY_PEM;
  const kid = env.LIBRITO_JWT_KID;
  const issuer = env.LIBRITO_JWT_ISSUER;
  if (!privateKeyPem || !kid || !issuer) {
    console.error("realtime.token_disabled", {
      hasPrivateKey: Boolean(privateKeyPem),
      hasKid: Boolean(kid),
      hasIssuer: Boolean(issuer),
    });
    return jsonError(
      503,
      "realtime_disabled",
      "Realtime token mint is not configured on this deployment",
    );
  }

  // Layered rate limit: per-device bounds reconnect storms, per-user bounds
  // re-pair-loop bypass (new device.id each pair sidesteps the device cap).
  const [perDevice, perUser] = await Promise.all([
    realtimeTokenLimiter.limit(device.id),
    realtimeTokenUserLimiter.limit(device.userId),
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
      privateKeyPem,
      kid,
      issuer,
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
