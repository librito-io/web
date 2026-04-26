import type { RequestHandler } from "./$types";
import { SUPABASE_JWT_SECRET } from "$env/static/private";
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
      jwtSecret: SUPABASE_JWT_SECRET,
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
