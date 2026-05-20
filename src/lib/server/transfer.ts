import { basename } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { firstRow } from "./rpc";
import type { Database } from "$lib/types/database";

type IncrementTransferAttemptRow =
  Database["public"]["Functions"]["increment_transfer_attempt"]["Returns"][number];

export { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "$lib/transfer-config";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "$lib/transfer-config";
export const MAX_FILENAME_LENGTH = 255;
export const MAX_PENDING_TRANSFERS = 20;
export const UPLOAD_URL_TTL = 300; // 5 minutes
// TTL for /api/transfer/[id]/download-url — device fetches the file promptly.
export const DOWNLOAD_URL_TTL = 300;
// TTL for URLs embedded in sync responses — longer window to accommodate
// the device's next sync cycle before it needs to fetch the file.
export const SYNC_DOWNLOAD_URL_TTL = 3600;

// Maximum /confirm-side failure attempts before a transfer flips to `failed`.
// Mirrored as the default of `increment_transfer_attempt(p_max_attempts)`.
export const MAX_TRANSFER_ATTEMPTS = 10;

export type ConfirmFailureContext = {
  transferId: string;
  userId: string;
  deviceId: string;
  updateError: { message: string; code: string };
};

type FailurePayloadBase = {
  transferId: string;
  userId: string;
  deviceId: string;
  error: string;
  errorCode: string;
};

export type ConfirmFailureLog =
  | {
      kind: "cap_hit_failed";
      payload: FailurePayloadBase & { attemptCount: number };
    }
  | {
      kind: "confirm_failure";
      payload: FailurePayloadBase & { newAttemptCount: number };
    }
  // RPC succeeded but matched zero rows — the row left `pending` between the
  // UPDATE error and the RPC call. attempt_count is unchanged, so a numeric
  // log would lie. Distinct kind keeps the pager signal honest.
  | { kind: "no_change"; payload: FailurePayloadBase }
  | { kind: "rpc_error" };

export async function recordConfirmFailure(
  supabase: SupabaseClient,
  ctx: ConfirmFailureContext,
): Promise<ConfirmFailureLog> {
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    "increment_transfer_attempt",
    {
      p_transfer_id: ctx.transferId,
      p_max_attempts: MAX_TRANSFER_ATTEMPTS,
    },
  );

  if (rpcError) return { kind: "rpc_error" };

  const row = firstRow<IncrementTransferAttemptRow>(rpcRows);
  const basePayload: FailurePayloadBase = {
    transferId: ctx.transferId,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    error: ctx.updateError.message,
    errorCode: ctx.updateError.code,
  };

  if (!row) {
    return { kind: "no_change", payload: basePayload };
  }

  const newAttemptCount = row.attempt_count ?? 0;
  const newStatus = row.status;

  if (newStatus === "failed") {
    return {
      kind: "cap_hit_failed",
      payload: { ...basePayload, attemptCount: newAttemptCount },
    };
  }

  return {
    kind: "confirm_failure",
    payload: { ...basePayload, newAttemptCount },
  };
}

export function sanitizeFilename(filename: string): string {
  // NFC canonical form for book_transfers.filename: macOS APFS stores
  // filenames as NFD, Linux/Windows typically NFC. Without normalization
  // the same title from different OSes produces unequal strings, breaking
  // any future filename-based comparison or cross-client display.
  // NFC alone does NOT satisfy Supabase Storage's key validator
  // (\w = [A-Za-z0-9_]); the storage path bug is fixed separately by
  // using a UUID-only key. See #216.
  return basename(filename).normalize("NFC");
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateTransferFilename(filename: string): ValidationResult {
  if (!filename.toLowerCase().endsWith(".epub"))
    return { ok: false, error: "Only EPUB files are accepted" };
  if (filename.length > MAX_FILENAME_LENGTH)
    return { ok: false, error: "Filename exceeds 255 character limit" };
  return { ok: true };
}

export function validateTransferSize(size: number): ValidationResult {
  if (size <= 0)
    return { ok: false, error: "File size must be greater than 0" };
  if (size > MAX_FILE_SIZE)
    return { ok: false, error: `File exceeds ${MAX_FILE_SIZE_LABEL} limit` };
  return { ok: true };
}

// Storage path is internal addressing only — must be ASCII-safe so that
// Supabase Storage's `isValidKey` regex (which rejects all non-ASCII via
// JS `\w` = `[A-Za-z0-9_]`) accepts it at `createSignedUrl` time. The
// user-facing filename lives in `book_transfers.filename` and is served
// via `Content-Disposition` on the signed download URL — it never enters
// the key. The first segment must remain the user's UUID to satisfy the
// RLS policy on `storage.objects` (foldername[1] = auth.uid()). Issue #216.
export function buildStoragePath(userId: string, transferId: string): string {
  return `${userId}/${transferId}.epub`;
}
