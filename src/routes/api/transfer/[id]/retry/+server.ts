import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({
  params,
  locals: { safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  const supabase = createAdminClient();
  const { id } = params;

  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, status, attempt_count, last_error")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    return jsonError(500, "server_error", "Failed to fetch transfer");
  }
  if (!transfer || transfer.user_id !== user.id) {
    return jsonError(404, "not_found", "Transfer not found");
  }
  if (transfer.status !== "failed") {
    return jsonError(409, "not_failed", "Transfer is not in a failed state");
  }

  const { error: updateError } = await supabase
    .from("book_transfers")
    .update({
      status: "pending",
      attempt_count: 0,
      last_error: null,
      last_attempt_at: null,
    })
    .eq("id", id)
    .eq("status", "failed");

  if (updateError) {
    return jsonError(500, "server_error", "Failed to reset transfer");
  }

  console.info("transfer.retry_reset", {
    transferId: transfer.id,
    userId: user.id,
    previousAttemptCount: transfer.attempt_count,
    previousLastError: transfer.last_error,
  });

  return jsonSuccess({ success: true });
};
