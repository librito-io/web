import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { transferUploadLimiter } from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import {
  sanitizeFilename,
  validateTransferFilename,
  validateTransferSize,
  buildStoragePath,
  UPLOAD_URL_TTL,
  MAX_PENDING_TRANSFERS,
} from "$lib/server/transfer";

export const POST: RequestHandler = async ({
  request,
  locals: { safeGetSession },
}) => {
  // Auth check — must be logged in
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  // Parse request body
  let body: { filename?: unknown; fileSize?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  const { filename, fileSize } = body;

  if (typeof filename !== "string" || !filename) {
    return jsonError(400, "invalid_request", "filename is required");
  }
  if (typeof fileSize !== "number") {
    return jsonError(400, "invalid_request", "fileSize must be a number");
  }

  // Sanitize filename (strip path components to prevent traversal)
  const safeFilename = sanitizeFilename(filename);

  // Rate limit by userId
  const { success, reset } = await transferUploadLimiter.limit(user.id);
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(429, "rate_limited", "Too many uploads", retryAfter);
  }

  // Validate filename and size
  const filenameError = validateTransferFilename(safeFilename);
  if (filenameError) return jsonError(400, "invalid_filename", filenameError);

  const sizeError = validateTransferSize(fileSize);
  if (sizeError) return jsonError(400, "file_too_large", sizeError);

  const supabase = createAdminClient();

  // Check pending transfer cap
  const { count, error: countError } = await supabase
    .from("book_transfers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .in("status", ["pending_upload", "pending"]);

  if (countError) {
    return jsonError(500, "server_error", "Failed to check transfer quota");
  }
  if ((count ?? 0) >= MAX_PENDING_TRANSFERS) {
    return jsonError(
      409,
      "queue_full",
      `You can have at most ${MAX_PENDING_TRANSFERS} pending transfers`,
    );
  }

  // Generate transfer ID and build storage path
  const transferId = crypto.randomUUID();
  const storagePath = buildStoragePath(user.id, transferId, safeFilename);

  // Create book_transfers row
  const { error: insertError } = await supabase.from("book_transfers").insert({
    id: transferId,
    user_id: user.id,
    device_id: null,
    filename: safeFilename,
    file_size: fileSize,
    storage_path: storagePath,
    sha256: "",
    status: "pending_upload",
  });

  if (insertError) {
    return jsonError(500, "server_error", "Failed to create transfer record");
  }

  // Create signed upload URL
  const { data: uploadData, error: urlError } = await supabase.storage
    .from("book-transfers")
    .createSignedUploadUrl(storagePath);

  if (urlError || !uploadData) {
    // Clean up orphaned DB row
    await supabase.from("book_transfers").delete().eq("id", transferId);
    return jsonError(500, "server_error", "Failed to create upload URL");
  }

  return jsonSuccess(
    { transferId, uploadUrl: uploadData.signedUrl, expiresIn: UPLOAD_URL_TTL },
    201,
  );
};
