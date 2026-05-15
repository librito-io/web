import type { RequestHandler } from "./$types";
import { authenticateDevice, authErrorResponse } from "$lib/server/auth";
import { createAdminClient } from "$lib/server/supabase";
import {
  transferConfirmLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { recordConfirmFailure } from "$lib/server/transfer";
import { logger } from "$lib/server/log";
import { UUID_RE } from "$lib/server/validation";

export const POST: RequestHandler = async ({ request, params }) => {
  const supabase = createAdminClient();
  const authResult = await authenticateDevice(request, supabase);

  if ("error" in authResult) {
    return authErrorResponse(authResult.error);
  }

  const { device } = authResult;
  const transferId = params.id;

  if (!UUID_RE.test(transferId)) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  const limited = await enforceRateLimit(
    transferConfirmLimiter,
    `${device.id}:${transferId}`,
    "Too many confirms",
  );
  if (limited) return limited;

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
      device_id: device.id,
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
      logger().error(
        { event: "transfer.cap_hit_failed", ...log.payload },
        "transfer.cap_hit_failed",
      );
    } else if (log.kind === "confirm_failure") {
      logger().warn(
        { event: "transfer.confirm_failure", ...log.payload },
        "transfer.confirm_failure",
      );
    } else if (log.kind === "no_change") {
      logger().warn(
        { event: "transfer.confirm_failure_no_change", ...log.payload },
        "transfer.confirm_failure_no_change",
      );
    }

    return jsonError(500, "server_error", "Failed to update transfer status");
  }

  // Supabase returns `data: []` (not an error) when the guarded UPDATE
  // matches zero rows — i.e. the row left `pending` between SELECT and
  // UPDATE. Treat as a TOCTOU race; do not log success or delete storage.
  if (!updateRows || updateRows.length === 0) {
    logger().warn(
      {
        event: "transfer.confirm_race",
        transferId: transfer.id,
        userId: device.userId,
        deviceId: device.id,
      },
      "transfer.confirm_race",
    );
    return jsonError(
      409,
      "already_confirmed",
      "Transfer has already been confirmed",
    );
  }

  logger().info(
    {
      event: "transfer.confirm_success",
      transferId: transfer.id,
      userId: device.userId,
      deviceId: device.id,
      attemptCountAtSuccess: transfer.attempt_count,
    },
    "transfer.confirm_success",
  );

  // Best-effort: delete file from storage
  if (transfer.storage_path) {
    try {
      await supabase.storage
        .from("book-transfers")
        .remove([transfer.storage_path]);
    } catch {
      // File cleanup is not critical
    }
  }

  return jsonSuccess({ success: true });
};
