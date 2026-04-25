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
    .select("id, user_id, status, storage_path, attempt_count")
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

  // Mark transfer as downloaded; reset attempt-accounting fields.
  const { error: updateError } = await supabase
    .from("book_transfers")
    .update({
      status: "downloaded",
      downloaded_at: new Date().toISOString(),
      attempt_count: 0,
      last_error: null,
      last_attempt_at: null,
    })
    .eq("id", transferId)
    .eq("status", "pending");

  if (updateError) {
    const { data: rpcRows, error: rpcError } = await supabase.rpc(
      "increment_transfer_attempt",
      { p_transfer_id: transferId },
    );

    if (rpcError) {
      // Cap-hit branch added in Task A.13.
      return jsonError(500, "server_error", "Failed to update transfer status");
    }

    const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    const newAttemptCount =
      (row as { attempt_count?: number } | null)?.attempt_count ?? 0;
    const newStatus = (row as { status?: string } | null)?.status;

    const errPayload = {
      transferId: transfer.id,
      userId: device.userId,
      deviceId: device.id,
      error: (updateError as { message?: string }).message,
      errorCode: (updateError as { code?: string }).code,
    };

    if (newStatus === "failed") {
      console.error("transfer.cap_hit_failed", {
        ...errPayload,
        attemptCount: newAttemptCount,
      });
    } else {
      console.warn("transfer.confirm_failure", {
        ...errPayload,
        newAttemptCount,
      });
    }

    return jsonError(500, "server_error", "Failed to update transfer status");
  }

  console.info("transfer.confirm_success", {
    transferId: transfer.id,
    userId: device.userId,
    deviceId: device.id,
    attemptCountAtSuccess: transfer.attempt_count,
  });

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
