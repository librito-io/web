import { basename } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { firstRow } from "./rpc";
import { logger } from "./log";
import type { Database } from "$lib/types/database";

const TRANSFER_BUCKET = "book-transfers";

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

const SHA256_RE = /^[0-9a-f]{64}$/;

export type ParsedInitiateBody = {
  safeFilename: string;
  fileSize: number;
  sha256: string;
};

export type ParseInitiateResult =
  | { ok: true; value: ParsedInitiateBody }
  | { ok: false; status: number; code: string; message: string };

// Validates the JSON payload of POST /app/api/transfer/initiate and returns a
// canonical { safeFilename, fileSize, sha256 } tuple. Mirrors the
// validateSyncPayload discriminated-result pattern so the route handler
// stays "auth → call helper → respond". HTTP error shape (status + code +
// message) flows through so the caller maps directly to jsonError.
export function parseInitiateBody(body: unknown): ParseInitiateResult {
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      message: "Request body must be a JSON object",
    };
  }
  const { filename, fileSize, sha256 } = body as {
    filename?: unknown;
    fileSize?: unknown;
    sha256?: unknown;
  };

  if (typeof filename !== "string" || !filename) {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      message: "filename is required",
    };
  }
  if (typeof fileSize !== "number") {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      message: "fileSize must be a number",
    };
  }

  const safeFilename = sanitizeFilename(filename);

  const filenameResult = validateTransferFilename(safeFilename);
  if (!filenameResult.ok) {
    return {
      ok: false,
      status: 400,
      code: "invalid_filename",
      message: filenameResult.error,
    };
  }

  const sizeResult = validateTransferSize(fileSize);
  if (!sizeResult.ok) {
    return {
      ok: false,
      status: 400,
      code: "file_too_large",
      message: sizeResult.error,
    };
  }

  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_sha256",
      message: "sha256 must be 64 lowercase hex chars",
    };
  }

  return { ok: true, value: { safeFilename, fileSize, sha256 } };
}

// Best-effort delete of a single object from the book-transfers bucket.
// Orphan-tolerant by design: the transfer-sweep cron's Pass A scans for
// retired rows whose Storage object never died (transient 5xx, ACL drift,
// confirm-time best-effort race) and retries the remove, then NULLs
// storage_path once Storage confirms deletion. Callers therefore do not
// need to surface, retry, or fail on Storage errors here — the sweep is
// the convergence point.
//
// supabase-js Storage operations return `{ data, error }`; they only throw
// on transport-level exceptions (fetch failure). Earlier call sites mixed
// "no check", "empty try/catch" (which only catches the rare throw, not
// the returned `error`), and "documented orphan-tolerance" — the three
// shapes converged on this helper per #125.
export async function removeTransferStorage(
  supabase: SupabaseClient,
  path: string,
): Promise<void> {
  try {
    const { error } = await supabase.storage
      .from(TRANSFER_BUCKET)
      .remove([path]);
    if (error) {
      logger().warn(
        {
          event: "transfer.storage_remove_failed",
          path,
          error: error.message ?? "unknown",
        },
        "transfer.storage_remove_failed",
      );
    }
  } catch (err) {
    logger().warn(
      {
        event: "transfer.storage_remove_threw",
        path,
        error: err instanceof Error ? err.message : String(err),
      },
      "transfer.storage_remove_threw",
    );
  }
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
