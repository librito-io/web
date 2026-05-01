import type { RequestHandler } from "./$types";
import { authenticateDevice } from "$lib/server/auth";
import { createAdminClient } from "$lib/server/supabase";
import { transferConfirmLimiter, legacySafeLimit } from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { recordConfirmFailure } from "$lib/server/transfer";

export const POST: RequestHandler = async ({ request, params }) => {
  const supabase = createAdminClient();
  const authResult = await authenticateDevice(request, supabase);

  if ("error" in authResult) {
    return jsonError(401, authResult.error, "Device authentication failed");
  }

  const { device } = authResult;
  const transferId = params.id;

  const { success, reset } = await legacySafeLimit(
    transferConfirmLimiter,
    `${device.id}:${transferId}`,
    "transfer:confirm",
  );
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(429, "rate_limited", "Too many confirms", retryAfter);
  }

  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, status, storage_path, attempt_count")
    .eq("id", transferId)
    .maybeSingle();

  if (fetchError || !transfer) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  if (transfer.user_id !== device.userId) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  if (transfer.status !== "pending") {
    return jsonError(
      409,
      "already_confirmed",
      "Transfer has already been confirmed",
    );
  }

  // Guarded UPDATE: status='pending' arm prevents double-confirm clobbering
  // a row that another path already moved out of pending.
  const { data: updateRows, error: updateError } = await supabase
    .from("book_transfers")
    .update({
      status: "downloaded",
      downloaded_at: new Date().toISOString(),
      attempt_count: 0,
      last_error: null,
      last_attempt_at: null,
    })
    .eq("id", transferId)
    .eq("status", "pending")
    .select("id");

  if (updateError) {
    const log = await recordConfirmFailure(supabase, {
      transferId: transfer.id,
      userId: device.userId,
      deviceId: device.id,
      updateError: {
        message: updateError.message,
        code: updateError.code,
      },
    });

    if (log.kind === "cap_hit_failed") {
      console.error("transfer.cap_hit_failed", log.payload);
    } else if (log.kind === "confirm_failure") {
      console.warn("transfer.confirm_failure", log.payload);
    } else if (log.kind === "no_change") {
      console.warn("transfer.confirm_failure_no_change", log.payload);
    }

    return jsonError(500, "server_error", "Failed to update transfer status");
  }

  // Supabase returns `data: []` (not an error) when the guarded UPDATE
  // matches zero rows — i.e. the row left `pending` between SELECT and
  // UPDATE. Treat as a TOCTOU race; do not log success or delete storage.
  if (!updateRows || updateRows.length === 0) {
    console.warn("transfer.confirm_race", {
      transferId: transfer.id,
      userId: device.userId,
      deviceId: device.id,
    });
    return jsonError(
      409,
      "already_confirmed",
      "Transfer has already been confirmed",
    );
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
    // File cleanup is not critical
  }

  return jsonSuccess({ success: true });
};
