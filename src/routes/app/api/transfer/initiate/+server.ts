import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { transferUploadLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import {
  buildStoragePath,
  parseInitiateBody,
  UPLOAD_URL_TTL,
  MAX_PENDING_TRANSFERS,
} from "$lib/server/transfer";
import { logger } from "$lib/server/log";
import { requireUser } from "$lib/server/auth";

export const POST: RequestHandler = async (event) => {
  const user = requireUser(event);
  const { request } = event;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    // Malformed client JSON → 400, not a server fault.
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  const parsed = parseInitiateBody(rawBody);
  if (!parsed.ok) return jsonError(parsed.status, parsed.code, parsed.message);
  const { safeFilename, fileSize, sha256: clientSha } = parsed.value;

  const limited = await enforceRateLimit(
    transferUploadLimiter,
    user.id,
    "Too many uploads",
  );
  if (limited) return limited;

  const supabase = createAdminClient();

  // Idempotent dedup. A prior pending row with the same (user_id, sha256)
  // wins; we hand back its transferId + a fresh signed upload URL so the
  // client can re-PUT after a network blip or a concurrent drag-drop of
  // the same bytes. Verified rows (sha256_verified IS NOT NULL) reject —
  // bytes are already locked in and shipped to the device on next sync.
  // Issue #141.
  const dedup = await lookupPendingBySha(supabase, user.id, clientSha);
  if (dedup.error) {
    return jsonError(500, "server_error", "Failed to check existing transfer");
  }
  if (dedup.row) {
    if (dedup.row.sha256_verified) {
      return jsonError(
        409,
        "duplicate_transfer",
        "An identical file is already pending transfer",
      );
    }
    if (!dedup.row.storage_path) {
      // Pending rows always carry storage_path; null indicates a scrubbed
      // row leaked through the status='pending' filter (invariant violation).
      return jsonError(
        500,
        "server_error",
        "Transfer is missing upload context",
      );
    }
    return reissueUploadUrl(supabase, dedup.row.id, dedup.row.storage_path);
  }

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

  const transferId = crypto.randomUUID();
  const storagePath = buildStoragePath(user.id, transferId);

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
    // Concurrent initiate landed the row first — partial unique index
    // (user_id, sha256) WHERE status='pending' raises 23505. Re-query and
    // return the winner's transferId so both callers converge on one row.
    const code = (insertError as { code?: string }).code;
    if (code === "23505") {
      const raced = await lookupPendingBySha(supabase, user.id, clientSha);
      if (raced.row && !raced.row.sha256_verified && raced.row.storage_path) {
        return reissueUploadUrl(supabase, raced.row.id, raced.row.storage_path);
      }
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

  logger().info(
    {
      event: "transfer.initiate",
      transferId,
      userId: user.id,
      filenameLen: safeFilename.length,
      fileSize,
      sha256Prefix: clientSha.slice(0, 12),
    },
    "transfer.initiate",
  );

  return jsonSuccess(
    { transferId, uploadUrl: uploadData.signedUrl, expiresIn: UPLOAD_URL_TTL },
    201,
  );
};

type AdminClient = ReturnType<typeof createAdminClient>;

async function lookupPendingBySha(
  supabase: AdminClient,
  userId: string,
  sha256: string,
): Promise<{
  row: {
    id: string;
    storage_path: string | null;
    sha256_verified: string | null;
  } | null;
  error: unknown;
}> {
  const { data, error } = await supabase
    .from("book_transfers")
    .select("id, storage_path, sha256_verified")
    .eq("user_id", userId)
    .eq("sha256", sha256)
    .eq("status", "pending")
    .maybeSingle();
  return { row: data ?? null, error };
}

async function reissueUploadUrl(
  supabase: AdminClient,
  transferId: string,
  storagePath: string,
) {
  const { data: uploadData, error: urlError } = await supabase.storage
    .from("book-transfers")
    .createSignedUploadUrl(storagePath);
  if (urlError || !uploadData) {
    return jsonError(500, "server_error", "Failed to create upload URL");
  }
  logger().info(
    { event: "transfer.initiate_idempotent", transferId },
    "transfer.initiate_idempotent",
  );
  return jsonSuccess(
    {
      transferId,
      uploadUrl: uploadData.signedUrl,
      expiresIn: UPLOAD_URL_TTL,
    },
    200,
  );
}
