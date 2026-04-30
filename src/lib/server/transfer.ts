import { basename } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { firstRow } from "./rpc";

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
export const MAX_FILENAME_LENGTH = 255;
export const MAX_PENDING_TRANSFERS = 20;
export const UPLOAD_URL_TTL = 300; // 5 minutes
export const DOWNLOAD_URL_TTL = 3600; // 1 hour

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

  const row = firstRow<{ attempt_count?: number; status?: string }>(rpcRows);
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
  return basename(filename);
}

export function validateTransferFilename(filename: string): string | null {
  if (!filename.toLowerCase().endsWith(".epub")) {
    return "Only EPUB files are accepted";
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return "Filename exceeds 255 character limit";
  }
  return null;
}

export function validateTransferSize(size: number): string | null {
  if (size <= 0) return "File size must be greater than 0";
  if (size > MAX_FILE_SIZE) return "File exceeds 20MB limit";
  return null;
}

export function buildStoragePath(
  userId: string,
  transferId: string,
  filename: string,
): string {
  return `${userId}/${transferId}/${filename}`;
}
