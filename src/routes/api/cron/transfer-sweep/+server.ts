import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { constantTimeEqualString } from "$lib/server/cron-auth";
import { CRON_SECRET } from "$env/static/private";
import { logger } from "$lib/server/log";

const BUCKET = "book-transfers";
const PASS_A_BATCH = 500;

// Vercel cron invokes scheduled paths via GET. A POST-only handler returns
// 405 every fire and never executes Pass A/B. See issue #187.
export const GET: RequestHandler = async ({ request }) => {
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${CRON_SECRET}`;
  if (!constantTimeEqualString(auth, expected)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }

  const start = Date.now();
  const supabase = createAdminClient();

  // Pass A — delete Storage objects for retired rows (expired or
  // downloaded). Confirm's best-effort remove may have failed on a
  // downloaded row; this pass closes the gap before scrub NULLs
  // storage_path 24 h later and the object becomes an orphan.
  const { data: retiredRows, error: selectError } = await supabase
    .from("book_transfers")
    .select("id, storage_path")
    .in("status", ["expired", "downloaded"])
    .not("storage_path", "is", null)
    .limit(PASS_A_BATCH);

  if (selectError) {
    return jsonError(500, "server_error", "Pass A select failed");
  }

  // Storage remove errors are intentionally swallowed: a failed remove still
  // nulls storage_path, which orphans the object. Pass C (future workstream,
  // plan §14) sweeps orphans by listing the bucket and reconciling.
  let passA = 0;
  for (const row of (retiredRows ?? []) as Array<{
    id: string;
    storage_path: string;
  }>) {
    await supabase.storage.from(BUCKET).remove([row.storage_path]);
    // Re-apply the status filter on UPDATE to close a TOCTOU window between
    // the SELECT above and this write — if the row transitioned out of a
    // retired status (e.g. /retry flipped 'failed' → 'pending', though Pass
    // A only selects 'expired'/'downloaded', a future migration could
    // widen the candidate set), nulling storage_path would orphan the file
    // on a live row.
    await supabase
      .from("book_transfers")
      .update({ storage_path: null })
      .eq("id", row.id)
      .in("status", ["expired", "downloaded"]);
    passA += 1;
  }
  const passADurationMs = Date.now() - start;
  logger().info(
    {
      event: "cron.transfer_sweep.pass_a",
      rowsAffected: passA,
      durationMs: passADurationMs,
    },
    "cron.transfer_sweep.pass_a",
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
    logger().error(
      {
        event: "cron.transfer_sweep.pass_b_failed",
        error: deleteError.message ?? "unknown",
      },
      "cron.transfer_sweep.pass_b_failed",
    );
    return jsonError(
      500,
      "server_error",
      `Pass B delete failed: ${deleteError.message ?? "unknown"}`,
    );
  }

  const passB = passBCount ?? 0;
  const passBDurationMs = Date.now() - passBStart;
  logger().info(
    {
      event: "cron.transfer_sweep.pass_b",
      rowsAffected: passB,
      durationMs: passBDurationMs,
    },
    "cron.transfer_sweep.pass_b",
  );

  return jsonSuccess({
    sweep: {
      passA,
      passB,
      durationMs: Date.now() - start,
    },
  });
};
