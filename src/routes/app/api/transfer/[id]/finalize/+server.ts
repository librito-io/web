import { createHash } from "node:crypto";
import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import {
  transferFinalizeLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { logger } from "$lib/server/log";
import { UUID_RE } from "$lib/server/validation";
import { requireUser } from "$lib/server/auth";

const BUCKET = "book-transfers";

export const POST: RequestHandler = async (event) => {
  const user = requireUser(event);
  const { params } = event;

  const transferId = params.id;
  if (!UUID_RE.test(transferId)) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  const limited = await enforceRateLimit(
    transferFinalizeLimiter,
    user.id,
    "Too many finalize requests",
  );
  if (limited) return limited;

  const supabase = createAdminClient();

  const { data: transfer, error: fetchError } = await supabase
    .from("book_transfers")
    .select("id, user_id, status, storage_path, sha256, sha256_verified")
    .eq("id", transferId)
    .is("scrubbed_at", null)
    .maybeSingle();

  if (fetchError) {
    return jsonError(500, "server_error", "Failed to fetch transfer");
  }
  if (!transfer || transfer.user_id !== user.id) {
    return jsonError(404, "not_found", "Transfer not found");
  }

  // Idempotency: a row already past verification is returned 200 without
  // re-reading storage. Browser retries (network blip between upload and
  // finalize) land here harmlessly.
  if (transfer.sha256_verified) {
    return jsonSuccess({ verified: true, idempotent: true });
  }

  if (transfer.status !== "pending") {
    return jsonError(
      409,
      "not_pending",
      "Transfer is not in a verifiable state",
    );
  }

  if (!transfer.storage_path || !transfer.sha256) {
    return jsonError(500, "server_error", "Transfer is missing upload context");
  }

  const { data: blob, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(transfer.storage_path);

  if (downloadError || !blob) {
    logger().warn(
      {
        event: "transfer.finalize_download_failed",
        transferId: transfer.id,
        userId: user.id,
        error: downloadError?.message ?? "no_blob",
      },
      "transfer.finalize_download_failed",
    );
    return jsonError(500, "verify_failed", "Cannot read uploaded file");
  }

  const buf = Buffer.from(await blob.arrayBuffer());
  const computed = createHash("sha256").update(buf).digest("hex");

  if (computed !== transfer.sha256) {
    // Mismatch — flip to 'failed'. Guarded by status='pending' so a
    // concurrent finalize/retry/cancel can't clobber a row that already
    // left pending; if the guarded UPDATE matches zero rows we still
    // surface 422 because the user-facing answer is "this upload didn't
    // verify and won't ship to the device" regardless of which path
    // moved the row.
    await supabase
      .from("book_transfers")
      .update({
        status: "failed",
        last_error: "sha256_mismatch",
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", transfer.id)
      .eq("user_id", user.id)
      .eq("status", "pending");

    logger().warn(
      {
        event: "transfer.finalize_mismatch",
        transferId: transfer.id,
        userId: user.id,
        claimedShaPrefix: transfer.sha256.slice(0, 12),
        computedShaPrefix: computed.slice(0, 12),
      },
      "transfer.finalize_mismatch",
    );

    return jsonError(
      422,
      "sha256_mismatch",
      "Uploaded file does not match the claimed hash",
    );
  }

  // Match — write verification. Guarded UPDATE: status='pending' AND
  // sha256_verified IS NULL closes both directions of the TOCTOU window
  // (cancellation between SELECT and UPDATE, and a concurrent finalize
  // by Pass C sweep that already wrote the same hash).
  const { data: updateRows, error: updateError } = await supabase
    .from("book_transfers")
    .update({
      sha256_verified: computed,
      verified_at: new Date().toISOString(),
    })
    .eq("id", transfer.id)
    .eq("user_id", user.id)
    .eq("status", "pending")
    .is("sha256_verified", null)
    .select("id");

  if (updateError) {
    return jsonError(500, "server_error", "Failed to mark transfer verified");
  }

  if (!updateRows || updateRows.length === 0) {
    logger().warn(
      {
        event: "transfer.finalize_race",
        transferId: transfer.id,
        userId: user.id,
      },
      "transfer.finalize_race",
    );
    return jsonError(
      409,
      "not_pending",
      "Transfer state changed during verification",
    );
  }

  logger().info(
    {
      event: "transfer.finalize_success",
      transferId: transfer.id,
      userId: user.id,
      bytes: buf.byteLength,
    },
    "transfer.finalize_success",
  );

  return jsonSuccess({ verified: true });
};
