import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { transferUploadLimiter, enforceRateLimit } from "$lib/server/ratelimit";
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

  const filenameResult = validateTransferFilename(safeFilename);
  if (!filenameResult.ok)
    return jsonError(400, "invalid_filename", filenameResult.error);

  const sizeResult = validateTransferSize(fileSize);
  if (!sizeResult.ok) return jsonError(400, "file_too_large", sizeResult.error);

  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    return jsonError(
      400,
      "invalid_sha256",
      "sha256 must be 64 lowercase hex chars",
    );
  }
  const clientSha = sha256;

  const limited = await enforceRateLimit(
    transferUploadLimiter,
    user.id,
    "Too many uploads",
  );
  if (limited) return limited;

  const supabase = createAdminClient();

  const { count, error: countError } = await supabase
    .from("book_transfers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "pending");

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

  const transferId = crypto.randomUUID();
  const storagePath = buildStoragePath(user.id, transferId, safeFilename);

  const { error: insertError } = await supabase.from("book_transfers").insert({
    id: transferId,
    user_id: user.id,
    device_id: null,
    filename: safeFilename,
    file_size: fileSize,
    storage_path: storagePath,
    sha256: clientSha,
    status: "pending",
  });

  if (insertError) {
    // Postgres unique_violation on the partial unique index.
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

  console.info("transfer.initiate", {
    transferId,
    userId: user.id,
    filenameLen: safeFilename.length,
    fileSize,
    sha256Prefix: clientSha.slice(0, 12),
  });

  return jsonSuccess(
    { transferId, uploadUrl: uploadData.signedUrl, expiresIn: UPLOAD_URL_TTL },
    201,
  );
};
