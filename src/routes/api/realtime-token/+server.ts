import type { RequestHandler } from "./$types";
import { SUPABASE_JWT_SECRET } from "$env/static/private";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice } from "$lib/server/auth";
import { realtimeTokenLimiter } from "$lib/server/ratelimit";
import { mintRealtimeToken } from "$lib/server/realtime";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({ request }) => {
  const supabase = createAdminClient();

  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    const messages = {
      missing_token: "Authorization header with Bearer token required",
      invalid_token: "Invalid device token",
      token_revoked: "Device token has been revoked. Re-pair the device.",
    } as const satisfies Record<typeof authResult.error, string>;
    return jsonError(401, authResult.error, messages[authResult.error]);
  }

  const { device } = authResult;

  const { success, reset } = await realtimeTokenLimiter.limit(device.id);
  if (!success) {
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

    return jsonSuccess({ token, expiresIn });
  } catch (err) {
    console.error("realtime.token_mint_failed", {
      userId: device.userId,
      deviceId: device.id,
      error: String(err),
    });
    return jsonError(500, "server_error", "Failed to mint Realtime token");
  }
};
