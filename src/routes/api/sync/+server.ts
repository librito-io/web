import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice } from "$lib/server/auth";
import { syncLimiter } from "$lib/server/ratelimit";
import { validateSyncPayload, processSync } from "$lib/server/sync";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({ request }) => {
  const supabase = createAdminClient();

  // 1. Authenticate device
  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    const messages: Record<string, string> = {
      missing_token: "Authorization header with Bearer token required",
      invalid_token: "Invalid device token",
      token_revoked: "Device token has been revoked. Re-pair the device.",
    };
    return jsonError(401, authResult.error, messages[authResult.error]);
  }

  const { device } = authResult;

  // 2. Rate limit by device ID
  const { success, reset } = await syncLimiter.limit(device.id);
  if (!success) {
    const retryAfter = Math.ceil((reset - Date.now()) / 1000);
    return jsonError(429, "rate_limited", "Too many sync requests", retryAfter);
  }

  // 3. Parse and validate payload
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  const validation = validateSyncPayload(body);
  if ("error" in validation) {
    return jsonError(400, "invalid_request", validation.error);
  }

  // 4. Process sync
  try {
    const response = await processSync(
      supabase,
      device.id,
      device.userId,
      validation.payload,
    );
    return jsonSuccess(response as unknown as Record<string, unknown>);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Sync processing failed";
    return jsonError(500, "server_error", message);
  }
};
