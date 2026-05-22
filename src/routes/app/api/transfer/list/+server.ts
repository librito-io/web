import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { transferListLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import { requireUser } from "$lib/server/auth";

export const GET: RequestHandler = async (event) => {
  const user = requireUser(event);

  const limited = await enforceRateLimit(
    transferListLimiter,
    user.id,
    "Too many requests",
  );
  if (limited) return limited;

  const supabase = createAdminClient();

  // Filter scrubbed rows: their PII fields (filename, sha256) are NULLed
  // 24 h post-delivery and the row only lingers another 24 h before hard
  // delete in cron/transfer-sweep Pass B. The Transfer UI declares
  // filename: string (non-null) so leaking stubs would render literal
  // "null". .limit(100) bounds per-user payload against bursty/scripted
  // upload cycles producing many downloaded rows inside the 24 h scrub
  // window. Cap is ~3× honest-user steady state (pending cap 20 +
  // recently-downloaded rows); pagination is intentionally deferred until
  // the transfer UI overhaul lands.
  const { data: transfers, error } = await supabase
    .from("book_transfers")
    .select(
      "id, filename, file_size, status, uploaded_at, downloaded_at, attempt_count, last_error, last_attempt_at",
    )
    .eq("user_id", user.id)
    .is("scrubbed_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(100);

  if (error) {
    return jsonError(500, "server_error", "Failed to fetch transfers");
  }

  return jsonSuccess({
    transfers: (transfers ?? []).map((t) => ({
      id: t.id,
      filename: t.filename,
      fileSize: t.file_size,
      status: t.status,
      uploadedAt: t.uploaded_at,
      downloadedAt: t.downloaded_at,
      attemptCount: t.attempt_count,
      lastError: t.last_error,
      lastAttemptAt: t.last_attempt_at,
    })),
  });
};
