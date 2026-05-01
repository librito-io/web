import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import {
  transferDownloadLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { DOWNLOAD_URL_TTL } from "$lib/server/transfer";

export const GET: RequestHandler = async ({ request, params }) => {
  const supabase = createAdminClient();

  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    return authErrorResponse(authResult.error);
  }

  const { device } = authResult;

  const limited = await enforceRateLimit(
    transferDownloadLimiter,
    device.id,
    "Too many requests",
  );
  if (limited) return limited;

  const { data: rows, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, device_id, status, storage_path, sha256, filename")
    .eq("id", params.id)
    .is("scrubbed_at", null);

  if (fetchError) {
    return jsonError(500, "server_error", "Failed to fetch transfer record");
  }

  const transfer = Array.isArray(rows) ? (rows[0] ?? null) : rows;

  if (!transfer || transfer.user_id !== device.userId) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  if (transfer.status !== "pending") {
    return jsonError(409, "not_pending", "Transfer is not in pending status");
  }

  if (transfer.device_id !== null && transfer.device_id !== device.id) {
    return jsonError(404, "not_found", "Transfer not found");
  }

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

  return jsonSuccess({
    downloadUrl: urlData.signedUrl,
    transferId: transfer.id,
    sha256: transfer.sha256,
    filename: transfer.filename,
  });
};
