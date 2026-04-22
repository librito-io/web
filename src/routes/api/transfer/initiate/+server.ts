import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { transferUploadLimiter } from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import {
  sanitizeFilename,
  validateTransferFilename,
  validateTransferSize,
  buildStoragePath,
  UPLOAD_URL_TTL,
  MAX_PENDING_TRANSFERS,
} from "$lib/server/transfer";

const SHA256_RE = /^[0-9a-f]{64}$/;

export const POST: RequestHandler = async ({
  request,
  locals: { safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  let body: { filename?: unknown; fileSize?: unknown; sha256?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  const { filename, fileSize, sha256 } = body;

  if (typeof filename !== "string" || !filename) {
    return jsonError(400, "invalid_request", "filename is required");
  }
  if (typeof fileSize !== "number") {
    return jsonError(400, "invalid_request", "fileSize must be a number");
  }

  const safeFilename = sanitizeFilename(filename);

  const filenameError = validateTransferFilename(safeFilename);
  if (filenameError) return jsonError(400, "invalid_filename", filenameError);

  const sizeError = validateTransferSize(fileSize);
  if (sizeError) return jsonError(400, "file_too_large", sizeError);

  // Optional in Deploy 1, required in Deploy 2.
  let clientSha: string | null = null;
  if (sha256 !== undefined) {
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      return jsonError(
        400,
        "invalid_sha256",
        "sha256 must be 64 lowercase hex chars",
      );
    }
    clientSha = sha256;
  }

  const { success, reset } = await transferUploadLimiter.limit(user.id);
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(429, "rate_limited", "Too many uploads", retryAfter);
  }

  const supabase = createAdminClient();

  // Queue cap — TRANSIENT LIST during Deploy 1 only.
  // Legacy pending_upload rows coexist with new pending rows until the drain
  // window + Task 9 migration complete. Without counting both, a user could
  // sit at 20 pending_upload + 20 pending = 40 effective queue. Task 9
  // collapses this back to `.eq("status", "pending")` once the enum is
  // tightened. If you touch this code after Deploy 2 lands and still see the
  // `.in(...)` call here, that is a missed cleanup — fix it.
  const { count, error: countError } = await supabase
    .from("book_transfers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .in("status", ["pending_upload", "pending"]);

  if (countError) {
    return jsonError(500, "server_error", "Failed to check transfer quota");
  }
  if ((count ?? 0) >= MAX_PENDING_TRANSFERS) {
    return jsonError(
      409,
      "queue_full",
      `You can have at most ${MAX_PENDING_TRANSFERS} pending transfers`,
    );
  }

  // Dedup SELECT — only when the client supplied a sha.
  if (clientSha !== null) {
    const { data: existing } = await supabase
      .from("book_transfers")
      .select("id")
      .eq("user_id", user.id)
      .eq("sha256", clientSha)
      .eq("status", "pending")
      .maybeSingle();
    if (existing) {
      return jsonError(
        409,
        "duplicate_transfer",
        "An identical file is already pending transfer",
      );
    }
  }

  const transferId = crypto.randomUUID();
  const storagePath = buildStoragePath(user.id, transferId, safeFilename);

  const { error: insertError } = await supabase.from("book_transfers").insert({
    id: transferId,
    user_id: user.id,
    device_id: null,
    filename: safeFilename,
    file_size: fileSize,
    storage_path: storagePath,
    sha256: clientSha ?? "",
    status: clientSha ? "pending" : "pending_upload",
  });

  if (insertError) {
    // Postgres unique_violation on the partial unique index — Deploy 2 only,
    // but the handler is written once and covers both.
    const code = (insertError as { code?: string }).code;
    if (code === "23505") {
      return jsonError(
        409,
        "duplicate_transfer",
        "An identical file is already pending transfer",
      );
    }
    return jsonError(500, "server_error", "Failed to create transfer record");
  }

  const { data: uploadData, error: urlError } = await supabase.storage
    .from("book-transfers")
    .createSignedUploadUrl(storagePath);

  if (urlError || !uploadData) {
    await supabase.from("book_transfers").delete().eq("id", transferId);
    return jsonError(500, "server_error", "Failed to create upload URL");
  }

  return jsonSuccess(
    { transferId, uploadUrl: uploadData.signedUrl, expiresIn: UPLOAD_URL_TTL },
    201,
  );
};
