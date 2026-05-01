import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { transferRetryLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({
  params,
  locals: { safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  const limited = await enforceRateLimit(
    transferRetryLimiter,
    user.id,
    "Too many retries",
  );
  if (limited) return limited;

  const supabase = createAdminClient();
  const { id } = params;

  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, status, attempt_count, last_error")
    .eq("id", id)
    .is("scrubbed_at", null)
    .maybeSingle();

  if (fetchError) {
    return jsonError(500, "server_error", "Failed to fetch transfer");
  }
  if (!transfer || transfer.user_id !== user.id) {
    return jsonError(404, "not_found", "Transfer not found");
  }
  if (transfer.status !== "failed") {
    console.warn("transfer.retry_invalid_status", {
      transferId: transfer.id,
      userId: user.id,
      status: transfer.status,
    });
    return jsonError(409, "not_failed", "Transfer is not in a failed state");
  }

  // Treat retry as a fresh attempt: reset uploaded_at so the 48h cron
  // doesn't expire the row immediately if the original upload is old.
  const { data: updateRows, error: updateError } = await supabase
    .from("book_transfers")
    .update({
      status: "pending",
      attempt_count: 0,
      last_error: null,
      last_attempt_at: null,
      uploaded_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "failed")
    .is("scrubbed_at", null)
    .select("id");

  if (updateError) {
    // Dedup partial unique index on (user_id, sha256) WHERE status='pending'.
    // Hits when the user re-uploaded the same file before retrying the old
    // failed row.
    if (updateError.code === "23505") {
      return jsonError(
        409,
        "duplicate_pending_transfer",
        "An identical file is already pending. Cancel that one first or skip retry.",
      );
    }
    return jsonError(500, "server_error", "Failed to reset transfer");
  }

  if (!updateRows || updateRows.length === 0) {
    console.warn("transfer.retry_race", {
      transferId: transfer.id,
      userId: user.id,
    });
    return jsonError(
      409,
      "retry_race",
      "Transfer state changed; refresh and try again",
    );
  }

  console.info("transfer.retry_reset", {
    transferId: transfer.id,
    userId: user.id,
    previousAttemptCount: transfer.attempt_count,
    previousLastError: transfer.last_error,
  });

  return jsonSuccess({ success: true });
};
