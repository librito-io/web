import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const DELETE: RequestHandler = async ({
  params,
  locals: { safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  const { id } = params;
  const supabase = createAdminClient();

  // Fetch the transfer and verify ownership
  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, storage_path, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    return jsonError(500, "server_error", "Failed to fetch transfer");
  }
  if (!transfer) {
    return jsonError(404, "not_found", "Transfer not found");
  }
  if (transfer.user_id !== user.id) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  // Only allow cancellation of pending transfers
  if (transfer.status === "downloaded" || transfer.status === "expired") {
    return jsonError(
      409,
      "cannot_cancel",
      "Transfer cannot be cancelled in its current status",
    );
  }

  // Best-effort delete from Storage (don't fail if file doesn't exist)
  if (transfer.storage_path) {
    await supabase.storage
      .from("book-transfers")
      .remove([transfer.storage_path]);
  }

  // Delete the database row
  const { error: deleteError } = await supabase
    .from("book_transfers")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return jsonError(500, "server_error", "Failed to delete transfer");
  }

  return jsonSuccess({ success: true });
};
