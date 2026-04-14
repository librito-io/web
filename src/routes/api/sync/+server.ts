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
    const messages = {
      missing_token: "Authorization header with Bearer token required",
      invalid_token: "Invalid device token",
      token_revoked: "Device token has been revoked. Re-pair the device.",
    } as const satisfies Record<typeof authResult.error, string>;
    const status = authResult.error === "token_revoked" ? 403 : 401;
    return jsonError(status, authResult.error, messages[authResult.error]);
  }

  const { device } = authResult;

  // 2. Rate limit by device ID
  const { success, reset } = await syncLimiter.limit(device.id);
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(429, "rate_limited", "Too many sync requests", retryAfter);
  }

  // 3. Read body and enforce size limit
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError(400, "invalid_request", "Failed to read request body");
  }

  if (rawBody.length > 1_048_576) {
    return jsonError(
      413,
      "payload_too_large",
      "Request body must not exceed 1 MB",
    );
  }

  // 4. Parse and validate payload
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  const validation = validateSyncPayload(body);
  if ("error" in validation) {
    return jsonError(400, "invalid_request", validation.error);
  }

  // 5. Process sync
  try {
    const response = await processSync(
      supabase,
      device.id,
      device.userId,
      validation.payload,
    );
    return jsonSuccess(response);
  } catch (err) {
    console.error("Sync processing failed:", err);
    return jsonError(500, "server_error", "Sync processing failed");
  }
};
