import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { transferCancelLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import { UUID_RE } from "$lib/server/validation";

export const DELETE: RequestHandler = async ({
  params,
  locals: { safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  const { id } = params;
  if (!UUID_RE.test(id)) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  const limited = await enforceRateLimit(
    transferCancelLimiter,
    user.id,
    "Too many cancellations",
  );
  if (limited) return limited;

  const supabase = createAdminClient();

  // Fetch the transfer and verify ownership. Filter scrubbed rows so the
  // response shape matches sibling endpoints (retry, download-url) — a
  // scrubbed row returns 404, not 409.
  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, storage_path, status")
    .eq("id", id)
    .is("scrubbed_at", null)
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

  // Self-authorizing DELETE: include user_id arm so the write defends itself
  // under RLS-bypassing service_role, matching the guarded-UPDATE pattern in
  // /confirm and /retry. Authorization no longer rests solely on the prior
  // SELECT-then-DELETE pair.
  const { error: deleteError } = await supabase
    .from("book_transfers")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (deleteError) {
    return jsonError(500, "server_error", "Failed to delete transfer");
  }

  return jsonSuccess({ success: true });
};
