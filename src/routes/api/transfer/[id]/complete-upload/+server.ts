import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { computeFileSha256 } from "$lib/server/transfer";

export const POST: RequestHandler = async ({
  params,
  request,
  locals: { safeGetSession },
}) => {
  // Auth check — must be logged in
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  const transferId = params.id;

  // Parse optional request body
  let encrypted = false;
  let iv: string | null = null;
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      if (typeof body.encrypted === "boolean") encrypted = body.encrypted;
      if (typeof body.iv === "string") iv = body.iv;
    }
  } catch {
    // Empty or non-JSON body is fine — encryption metadata is optional
  }

  const supabase = createAdminClient();

  // Fetch transfer row, verify ownership
  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, filename, file_size, storage_path, status")
    .eq("id", transferId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (fetchError || !transfer) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  // Check status
  if (transfer.status !== "pending_upload") {
    return jsonError(
      410,
      "upload_expired",
      "Transfer is no longer pending upload",
    );
  }

  // Check file exists in Storage and download for verification
  const { data: fileData, error: downloadError } = await supabase.storage
    .from("book-transfers")
    .download(transfer.storage_path);

  if (downloadError || !fileData) {
    return jsonError(422, "file_missing", "File not found in storage");
  }

  const buffer = Buffer.from(await fileData.arrayBuffer());

  // Verify file size matches declared size
  if (buffer.byteLength !== transfer.file_size) {
    return jsonError(
      422,
      "size_mismatch",
      "File size does not match declared size",
    );
  }

  // Compute SHA-256
  const sha256 = computeFileSha256(buffer);

  // Check for duplicate: same user + same sha256 + status 'pending' + different id
  const { data: duplicate } = await supabase
    .from("book_transfers")
    .select("id")
    .eq("user_id", user.id)
    .eq("sha256", sha256)
    .eq("status", "pending")
    .neq("id", transferId)
    .maybeSingle();

  if (duplicate) {
    // Clean up the duplicate upload
    await supabase.storage
      .from("book-transfers")
      .remove([transfer.storage_path]);
    await supabase.from("book_transfers").delete().eq("id", transferId);
    return jsonError(
      409,
      "duplicate_transfer",
      "An identical file is already pending transfer",
    );
  }

  // Update row: sha256, status → 'pending', encrypted, iv
  const uploadedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("book_transfers")
    .update({
      sha256,
      status: "pending",
      encrypted,
      iv,
      updated_at: uploadedAt,
    })
    .eq("id", transferId)
    .select("id, filename, file_size, status, updated_at")
    .single();

  if (updateError || !updated) {
    return jsonError(500, "server_error", "Failed to update transfer record");
  }

  return jsonSuccess({
    transfer: {
      id: updated.id,
      filename: updated.filename,
      fileSize: updated.file_size,
      status: updated.status,
      uploadedAt: updated.updated_at,
    },
  });
};
