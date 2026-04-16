import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { createAdminClient } from "$lib/server/supabase";
import { transferUploadLimiter } from "$lib/server/ratelimit";
import { jsonError } from "$lib/server/errors";
import {
  validateTransferFilename,
  validateTransferSize,
  buildStoragePath,
  UPLOAD_URL_TTL,
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

  // Rate limit by userId
  const { success, reset } = await transferUploadLimiter.limit(user.id);
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(429, "rate_limited", "Too many uploads", retryAfter);
  }

  // Validate filename and size
  const filenameError = validateTransferFilename(filename);
  if (filenameError) return jsonError(400, "invalid_filename", filenameError);

  const sizeError = validateTransferSize(fileSize);
  if (sizeError) return jsonError(400, "file_too_large", sizeError);

  // Generate transfer ID and build storage path
  const transferId = crypto.randomUUID();
  const storagePath = buildStoragePath(user.id, transferId, filename);

  const supabase = createAdminClient();

  // Create book_transfers row
  const { error: insertError } = await supabase.from("book_transfers").insert({
    id: transferId,
    user_id: user.id,
    device_id: null,
    filename,
    file_size: fileSize,
    storage_path: storagePath,
    sha256: "",
    status: "pending_upload",
    encrypted: false,
  });

  if (insertError) {
    return jsonError(500, "server_error", "Failed to create transfer record");
  }

  // Create signed upload URL
  const { data: uploadData, error: urlError } = await supabase.storage
    .from("book-transfers")
    .createSignedUploadUrl(storagePath);

  if (urlError || !uploadData) {
    return jsonError(500, "server_error", "Failed to create upload URL");
  }

  return json(
    { transferId, uploadUrl: uploadData.signedUrl, expiresIn: UPLOAD_URL_TTL },
    { status: 201 },
  );
};
