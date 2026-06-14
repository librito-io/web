import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import { importKoboLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import {
  validateKoboPayload,
  processKoboImport,
} from "$lib/server/import/kobo";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { logger } from "$lib/server/log";

// POST /api/import/kobo — ingest Kobo highlights from the on-device agent.
// Separate write path from /api/sync (see src/lib/server/import/kobo.ts).
// A paired Kobo is a `devices` row exactly like a PaperS3; auth derives the
// user_id from the token — payload user_id is never trusted.
export const POST: RequestHandler = async ({ request }) => {
  const supabase = createAdminClient();

  // 1. Authenticate device (Bearer sk_device_xxx → user_id + device_id).
  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    return authErrorResponse(authResult.error);
  }
  const { device } = authResult;

  // 2. Rate limit by device ID.
  const limited = await enforceRateLimit(
    importKoboLimiter,
    device.id,
    "Too many import requests",
  );
  if (limited) return limited;

  // 3. Read body and enforce size limit.
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

  // 4. Parse + validate.
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  const validation = validateKoboPayload(body);
  if ("error" in validation) {
    return jsonError(400, "invalid_request", validation.error);
  }

  // 5. Import.
  try {
    const result = await processKoboImport(
      supabase,
      device.userId,
      validation.items,
      validation.complete,
    );
    return jsonSuccess(result);
  } catch (err) {
    logger().error(
      {
        event: "import.kobo.processing_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "import.kobo.processing_failed",
    );
    return jsonError(500, "server_error", "Import processing failed");
  }
};
