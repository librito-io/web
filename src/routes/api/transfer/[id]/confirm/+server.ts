import type { RequestHandler } from "./$types";
import { authenticateDevice } from "$lib/server/auth";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({ request, params }) => {
  const supabase = createAdminClient();
  const authResult = await authenticateDevice(request, supabase);

  if ("error" in authResult) {
    return jsonError(401, authResult.error, "Device authentication failed");
  }

  const { device } = authResult;
  const transferId = params.id;

  // Fetch transfer record
  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, status, storage_path")
    .eq("id", transferId)
    .maybeSingle();

  if (fetchError || !transfer) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  // Verify the transfer belongs to this device's user
  if (transfer.user_id !== device.userId) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  // Verify status is pending
  if (transfer.status !== "pending") {
    return jsonError(
      409,
      "already_confirmed",
      "Transfer has already been confirmed",
    );
  }

  // Mark transfer as downloaded
  const { error: updateError } = await supabase
    .from("book_transfers")
    .update({ status: "downloaded", downloaded_at: new Date().toISOString() })
    .eq("id", transferId);

  if (updateError) {
    return jsonError(500, "server_error", "Failed to update transfer status");
  }

  // Best-effort: delete file from storage
  try {
    await supabase.storage
      .from("book-transfers")
      .remove([transfer.storage_path]);
  } catch {
    // Best-effort: file cleanup is not critical
  }

  return jsonSuccess({ success: true });
};
