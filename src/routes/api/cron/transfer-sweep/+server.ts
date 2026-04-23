import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { CRON_SECRET } from "$env/static/private";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

const BUCKET = "book-transfers";
const PASS_A_BATCH = 500;

export const POST: RequestHandler = async ({ request }) => {
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${CRON_SECRET}`;
  if (!timingSafeEqual(auth, expected)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }

  const start = Date.now();
  const supabase = createAdminClient();

  // Pass A — delete Storage objects for expired rows.
  const { data: expiredRows, error: selectError } = await supabase
    .from("book_transfers")
    .select("id, storage_path")
    .eq("status", "expired")
    .not("storage_path", "is", null)
    .limit(PASS_A_BATCH);

  if (selectError) {
    return jsonError(500, "server_error", "Pass A select failed");
  }

  let passA = 0;
  for (const row of (expiredRows ?? []) as Array<{
    id: string;
    storage_path: string;
  }>) {
    await supabase.storage.from(BUCKET).remove([row.storage_path]);
    await supabase
      .from("book_transfers")
      .update({ storage_path: null })
      .eq("id", row.id);
    passA += 1;
  }
  const passADurationMs = Date.now() - start;
  console.log(
    JSON.stringify({
      sweep: "A",
      rowsAffected: passA,
      durationMs: passADurationMs,
    }),
  );

  // Pass B — hard-delete scrubbed rows past 24 h grace.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const passBStart = Date.now();
  const { error: deleteError, count: passBCount } = await supabase
    .from("book_transfers")
    .delete({ count: "exact" })
    .not("scrubbed_at", "is", null)
    .lt("scrubbed_at", cutoff);

  if (deleteError) {
    return jsonError(500, "server_error", "Pass B delete failed");
  }

  const passB = passBCount ?? 0;
  const passBDurationMs = Date.now() - passBStart;
  console.log(
    JSON.stringify({
      sweep: "B",
      rowsAffected: passB,
      durationMs: passBDurationMs,
    }),
  );

  return jsonSuccess({
    sweep: {
      passA,
      passB,
      durationMs: Date.now() - start,
    },
  });
};
