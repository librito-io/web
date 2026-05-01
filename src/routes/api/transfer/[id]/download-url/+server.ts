import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import {
  transferDownloadLimiter,
  legacySafeLimit,
} from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { DOWNLOAD_URL_TTL } from "$lib/server/transfer";

export const GET: RequestHandler = async ({ request, params }) => {
  const supabase = createAdminClient();

  // 1. Authenticate device
  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    return authErrorResponse(authResult.error);
  }

  const { device } = authResult;

  // 2. Rate limit by device ID
  const { success, reset } = await legacySafeLimit(
    transferDownloadLimiter,
    device.id,
    "transfer:download",
  );
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(429, "rate_limited", "Too many requests", retryAfter);
  }

  // 3. Fetch transfer and verify ownership + status
  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select(
      "id, user_id, device_id, status, storage_path, sha256, filename, file_size",
    )
    .eq("id", params.id)
    .maybeSingle();

  if (fetchError) {
    return jsonError(500, "server_error", "Failed to fetch transfer record");
  }

  if (!transfer || transfer.user_id !== device.userId) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  if (transfer.status !== "pending") {
    return jsonError(404, "not_found", "Transfer not found");
  }

  if (transfer.device_id !== null && transfer.device_id !== device.id) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  // 4. Generate signed download URL (1-hour TTL)
  const { data: urlData, error: urlError } = await supabase.storage
    .from("book-transfers")
    .createSignedUrl(transfer.storage_path, DOWNLOAD_URL_TTL);

  if (urlError || !urlData) {
    return jsonError(500, "server_error", "Failed to generate download URL");
  }

  console.info("transfer.download_url_issued", {
    transferId: transfer.id,
    userId: device.userId,
    deviceId: device.id,
    ttl: DOWNLOAD_URL_TTL,
  });

  // 5. Return URL + metadata
  return jsonSuccess({
    url: urlData.signedUrl,
    sha256: transfer.sha256,
    filename: transfer.filename,
    fileSize: transfer.file_size,
    expiresIn: DOWNLOAD_URL_TTL,
  });
};
