import { createHash } from "node:crypto";
import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { constantTimeEqualString } from "$lib/server/cron-auth";
// `$env/dynamic/private` (runtime read) is required because CRON_SECRET is
// marked Sensitive in Vercel. Sensitive vars are redacted by `vercel pull`,
// so `$env/static/private` (build-inlined) would bake an empty string into
// the deployed bundle and every cron fire would 401. See PR #194 thread.
import { env as privateEnv } from "$env/dynamic/private";
import { logger } from "$lib/server/log";

const BUCKET = "book-transfers";
const PASS_A_BATCH = 500;
// Pass C — backstop for /finalize. A browser that closes its tab between
// uploadToSignedUrl and POST /finalize leaves a pending row with
// sha256_verified = NULL. The sync gate (#287) filters those rows out, so
// without a backstop the row would sit invisible until the 48h pg_cron
// 'expire-stale-transfers' job ticks. PASS_C_AGE_MS sets the minimum age a
// pending+unverified row must reach before Pass C reaches for it — long
// enough that a normal /finalize round-trip (which takes seconds) doesn't
// race the sweep on every-hour invocations.
const PASS_C_BATCH = 100;
const PASS_C_AGE_MS = 15 * 60 * 1000; // 15 minutes

// Vercel cron invokes scheduled paths via GET. A POST-only handler returns
// 405 every fire and never executes Pass A/B. See issue #187.
export const GET: RequestHandler = async ({ request, url }) => {
  const cronSecret = privateEnv.CRON_SECRET;
  if (!cronSecret) {
    return jsonError(500, "server_misconfigured", "CRON_SECRET unset");
  }
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (!constantTimeEqualString(auth, expected)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }

  // ?probe=1 lets the deploy-time smoke check exercise auth + reachability
  // without doing the actual sweep (Storage deletes, DB writes). Gated
  // behind successful auth so an unauthenticated caller can never trigger
  // the short-circuit.
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
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

  // Pass C — server-side sha256 verification backstop. Picks up pending
  // rows that uploaded successfully but never received a /finalize POST
  // (browser closed the tab, network blip, retry-burn). Each row is
  // downloaded, hashed, and either verified or flipped to 'failed' with
  // last_error='sha256_mismatch'.
  const passCStart = Date.now();
  const passCCutoff = new Date(Date.now() - PASS_C_AGE_MS).toISOString();
  const { data: pendingUnverified, error: pcSelectError } = await supabase
    .from("book_transfers")
    .select("id, user_id, storage_path, sha256, uploaded_at")
    .eq("status", "pending")
    .is("sha256_verified", null)
    .not("storage_path", "is", null)
    .lt("uploaded_at", passCCutoff)
    .limit(PASS_C_BATCH);

  let passC = 0;
  let passCMismatches = 0;
  if (pcSelectError) {
    logger().error(
      {
        event: "cron.transfer_sweep.pass_c_select_failed",
        error: pcSelectError.message ?? "unknown",
      },
      "cron.transfer_sweep.pass_c_select_failed",
    );
  } else {
    for (const row of (pendingUnverified ?? []) as Array<{
      id: string;
      user_id: string;
      storage_path: string;
      sha256: string;
    }>) {
      const { data: blob, error: dlError } = await supabase.storage
        .from(BUCKET)
        .download(row.storage_path);

      if (dlError || !blob) {
        logger().warn(
          {
            event: "cron.transfer_sweep.pass_c_download_failed",
            transferId: row.id,
            error: dlError?.message ?? "no_blob",
          },
          "cron.transfer_sweep.pass_c_download_failed",
        );
        continue;
      }

      const buf = Buffer.from(await blob.arrayBuffer());
      const computed = createHash("sha256").update(buf).digest("hex");

      if (computed === row.sha256) {
        // Guarded UPDATE: status='pending' AND sha256_verified IS NULL.
        // /finalize landing first (single-writer race) makes this a
        // zero-row no-op; the row is already verified.
        await supabase
          .from("book_transfers")
          .update({
            sha256_verified: computed,
            verified_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("status", "pending")
          .is("sha256_verified", null);
        passC += 1;
      } else {
        await supabase
          .from("book_transfers")
          .update({
            status: "failed",
            last_error: "sha256_mismatch",
            last_attempt_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("status", "pending");
        passCMismatches += 1;
        logger().warn(
          {
            event: "cron.transfer_sweep.pass_c_mismatch",
            transferId: row.id,
            userId: row.user_id,
            claimedShaPrefix: row.sha256.slice(0, 12),
            computedShaPrefix: computed.slice(0, 12),
          },
          "cron.transfer_sweep.pass_c_mismatch",
        );
      }
    }
  }
  const passCDurationMs = Date.now() - passCStart;
  logger().info(
    {
      event: "cron.transfer_sweep.pass_c",
      verified: passC,
      mismatches: passCMismatches,
      durationMs: passCDurationMs,
    },
    "cron.transfer_sweep.pass_c",
  );

  return jsonSuccess({
    sweep: {
      passA,
      passB,
      passC,
      passCMismatches,
      durationMs: Date.now() - start,
    },
  });
};
