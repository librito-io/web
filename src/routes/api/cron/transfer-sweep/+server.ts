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
import * as Sentry from "@sentry/sveltekit";

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

// Mirror of vercel.ts crons[] entry for /api/cron/transfer-sweep. Sentry's
// monitor config needs the schedule at the SDK call site to compute
// expected check-in times; Vercel reads vercel.ts at a different layer.
// Drift surfaces fast — a real off-schedule fire produces a "missed
// check-in" alert in the Sentry Crons UI within minutes.
const TRANSFER_SWEEP_SCHEDULE = "0 3 * * *";

type SweepSummary = {
  passAStorageRemoved: number;
  passAStorageFailed: number;
  passAPathNulled: number;
  passB: number;
  passC: number;
  passCMismatches: number;
  durationMs: number;
};

async function runSweep(): Promise<SweepSummary> {
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
    // throw, not jsonError — Sentry.withMonitor marks a check-in failed
    // only when the wrapped callback throws. A returned non-2xx Response
    // counts as success. Outer handler translates back to 500.
    throw new Error("Pass A select failed");
  }

  // Batched Storage.remove + bulk UPDATE — one round-trip each rather than
  // two per row. With PASS_A_BATCH=500, this collapses ~1000 sequential
  // hops to 2 (issue #278), keeping the cron well under Vercel's 300 s
  // budget as the backlog grows.
  //
  // Type-safe null narrowing on storage_path: the SELECT filters
  // `.not("storage_path", "is", null)`, but the generated Row type is
  // `string | null` regardless of WHERE clause, so a regressed filter
  // would silently pass `null` to `remove([null])`. Narrow with a type
  // predicate instead of casting.
  const rows = (retiredRows ?? []).filter(
    (r): r is { id: string; storage_path: string } => r.storage_path !== null,
  );
  // Three counters, not one. A silent Storage failure (transient 5xx, ACL
  // drift) that we conflate with success leaves an orphan in Storage while
  // every operator signal reports a clean sweep. Splitting removed/failed/
  // nulled lets operators (and a future orphan-reconciliation pass)
  // distinguish a clean sweep from one that created orphans. Issue #277.
  let passAStorageRemoved = 0;
  let passAStorageFailed = 0;
  let passAPathNulled = 0;
  if (rows.length > 0) {
    const paths = rows.map((r) => r.storage_path);
    const { data: removed, error: removeError } = await supabase.storage
      .from(BUCKET)
      .remove(paths);
    if (removeError) {
      // Top-level error: assume the entire batch failed. Do NOT null
      // storage_path for any row; next sweep retries the whole batch.
      passAStorageFailed = rows.length;
    } else {
      // Per-path: paths absent from `data` (partial failure) stay
      // populated for the next sweep to retry. Set ensures we only null
      // storage_path for rows the Storage API confirmed it deleted.
      const removedSet = new Set((removed ?? []).map((f) => f.name));
      const idsToNull = rows
        .filter((r) => removedSet.has(r.storage_path))
        .map((r) => r.id);
      passAStorageRemoved = idsToNull.length;
      passAStorageFailed = rows.length - passAStorageRemoved;

      if (idsToNull.length > 0) {
        // Re-apply the status filter on UPDATE to close a TOCTOU window
        // between the SELECT above and this write — if a row transitioned
        // out of a retired status, nulling storage_path would orphan the
        // file on a live row.
        const { error: updateError } = await supabase
          .from("book_transfers")
          .update({ storage_path: null })
          .in("id", idsToNull)
          .in("status", ["expired", "downloaded"]);
        if (!updateError) passAPathNulled = idsToNull.length;
      }
    }
  }
  if (passAStorageFailed > 0) {
    // Loud signal per CLAUDE.md "Cron handlers" — orphans accumulate
    // silently otherwise. Sentry warning, not error: failed-but-tracked
    // rows are retried next sweep; persistent failure surfaces as an
    // alert pattern in the Crons UI.
    Sentry.captureMessage("transfer_sweep_pass_a_storage_failure", {
      level: "warning",
      extra: {
        passAStorageRemoved,
        passAStorageFailed,
        passAPathNulled,
        batchSize: rows.length,
      },
    });
  }
  const passADurationMs = Date.now() - start;
  logger().info(
    {
      event: "cron.transfer_sweep.pass_a",
      passAStorageRemoved,
      passAStorageFailed,
      passAPathNulled,
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
    throw new Error(
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
    // Pass C select failures log-and-continue rather than throw — Pass A
    // and Pass B already succeeded by this point and the monitor should
    // record success. Pass C is a backstop; missing a single run is not
    // a sweep-level failure.
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

  return {
    passAStorageRemoved,
    passAStorageFailed,
    passAPathNulled,
    passB,
    passC,
    passCMismatches,
    durationMs: Date.now() - start,
  };
}

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
  // the short-circuit. Outside the withMonitor scope: emitting check-ins
  // for probe runs would skew the Sentry Crons timeline.
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }

  try {
    const summary = await Sentry.withMonitor("transfer-sweep", runSweep, {
      schedule: { type: "crontab", value: TRANSFER_SWEEP_SCHEDULE },
      checkinMargin: 5, // minutes — alert if check-in late by >5 min
      maxRuntime: 10, // minutes — alert if run takes >10 min
      failureIssueThreshold: 1, // first failure creates an issue
      recoveryThreshold: 1, // one success after failure resolves it
    });
    return jsonSuccess({ sweep: summary });
  } catch (err) {
    // withMonitor already emitted an error check-in to Sentry. The
    // sentryHandle() wrapper in hooks.server.ts will also captureException
    // via handleErrorWithSentry — acceptable duplication; both surfaces
    // are useful (Crons UI shows failure pattern, Issues UI shows stack).
    return jsonError(
      500,
      "server_error",
      err instanceof Error ? err.message : "transfer_sweep_failed",
    );
  }
};
