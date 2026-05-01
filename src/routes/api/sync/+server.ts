import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import { syncLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import { validateSyncPayload, processSync } from "$lib/server/sync";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({ request }) => {
  const supabase = createAdminClient();

  // 1. Authenticate device
  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    return authErrorResponse(authResult.error);
  }

  const { device } = authResult;

  // 2. Rate limit by device ID
  const limited = await enforceRateLimit(
    syncLimiter,
    device.id,
    "Too many sync requests",
  );
  if (limited) return limited;

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
