import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/sveltekit";
import { logger } from "$lib/server/log";

const BUCKET = "book-transfers";
const PASS_A_BATCH_DEFAULT = 500;
// Pass C — backstop for /finalize. A browser that closes its tab between
// uploadToSignedUrl and POST /finalize leaves a pending row with
// sha256_verified = NULL. The sync gate (#287) filters those rows out, so
// without a backstop the row would sit invisible until the 48h pg_cron
// 'expire-stale-transfers' job ticks. PASS_C_AGE_MS sets the minimum age a
// pending+unverified row must reach before Pass C reaches for it — long
// enough that a normal /finalize round-trip (which takes seconds) doesn't
// race the sweep on every-hour invocations.
const PASS_C_BATCH = 100;
const PASS_C_AGE_MS = 15 * 60 * 1000;

export type SweepSummary = {
  passAStorageRemoved: number;
  passAStorageFailed: number;
  passAPathNulled: number;
  passB: number;
  passC: number;
  passCMismatches: number;
  durationMs: number;
};

type PassACounts = {
  passAStorageRemoved: number;
  passAStorageFailed: number;
  passAPathNulled: number;
};

async function runPassA(
  supabase: SupabaseClient,
  batchSize: number,
): Promise<PassACounts> {
  const start = Date.now();

  // Pass A — delete Storage objects for retired rows (expired or
  // downloaded). Confirm's best-effort remove may have failed on a
  // downloaded row; this pass closes the gap before scrub NULLs
  // storage_path 24 h later and the object becomes an orphan.
  const { data: retiredRows, error: selectError } = await supabase
    .from("book_transfers")
    .select("id, storage_path")
    .in("status", ["expired", "downloaded"])
    .not("storage_path", "is", null)
    .limit(batchSize);

  if (selectError) {
    // throw, not jsonError — Sentry.withMonitor marks a check-in failed
    // only when the wrapped callback throws. A returned non-2xx Response
    // counts as success. Outer handler translates back to 500.
    throw new Error("Pass A select failed");
  }

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
  // Propagated to Sentry `extra` and the structured log. Without this the
  // Sentry warning carried counts only — LIBRITO-WEB-9's trace had zero
  // log entries, so the actual Storage error (or lack thereof) was
  // invisible. Empty string when the failure was per-path (no top-level
  // error) rather than a batch-level Storage failure.
  let removeErrorMessage = "";

  if (rows.length > 0) {
    const paths = rows.map((r) => r.storage_path);
    // Batched Storage.remove + bulk UPDATE — one round-trip each rather
    // than two per row. With PASS_A_BATCH=500, this collapses ~1000
    // sequential hops to 2 (issue #278), keeping the cron well under
    // Vercel's 300 s budget as the backlog grows.
    const { data: removed, error: removeError } = await supabase.storage
      .from(BUCKET)
      .remove(paths);
    if (removeError) {
      // Top-level error: assume the entire batch failed. Do NOT null
      // storage_path for any row; next sweep retries the whole batch.
      passAStorageFailed = rows.length;
      removeErrorMessage = removeError.message ?? "unknown";
      logger().error(
        {
          event: "cron.transfer_sweep.pass_a_remove_failed",
          batchSize: rows.length,
          error: removeErrorMessage,
        },
        "cron.transfer_sweep.pass_a_remove_failed",
      );
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
        // Empty string when the failure was per-path (Storage returned
        // success at the batch level but omitted some paths from `data`).
        // Per-path failure is no longer expected post-LIBRITO-WEB-9 — the
        // confirm endpoint now nulls storage_path on successful remove,
        // so Pass A only re-targets paths that confirm's best-effort
        // remove genuinely missed. If you see this firing with an empty
        // removeErrorMessage, suspect a new writer that's not nulling
        // storage_path.
        removeErrorMessage,
      },
    });
  }

  logger().info(
    {
      event: "cron.transfer_sweep.pass_a",
      passAStorageRemoved,
      passAStorageFailed,
      passAPathNulled,
      durationMs: Date.now() - start,
    },
    "cron.transfer_sweep.pass_a",
  );

  return { passAStorageRemoved, passAStorageFailed, passAPathNulled };
}

async function runPassB(supabase: SupabaseClient): Promise<number> {
  // Pass B — hard-delete scrubbed rows past 24 h grace.
  const start = Date.now();
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { error: deleteError, count } = await supabase
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

  const passB = count ?? 0;
  logger().info(
    {
      event: "cron.transfer_sweep.pass_b",
      rowsAffected: passB,
      durationMs: Date.now() - start,
    },
    "cron.transfer_sweep.pass_b",
  );
  return passB;
}

async function runPassC(
  supabase: SupabaseClient,
): Promise<{ passC: number; passCMismatches: number }> {
  // Pass C — server-side sha256 verification backstop. Picks up pending
  // rows that uploaded successfully but never received a /finalize POST
  // (browser closed the tab, network blip, retry-burn). Each row is
  // downloaded, hashed, and either verified or flipped to 'failed' with
  // last_error='sha256_mismatch'.
  const start = Date.now();
  const cutoff = new Date(Date.now() - PASS_C_AGE_MS).toISOString();
  const { data: pendingUnverified, error: selectError } = await supabase
    .from("book_transfers")
    .select("id, user_id, storage_path, sha256, uploaded_at")
    .eq("status", "pending")
    .is("sha256_verified", null)
    .not("storage_path", "is", null)
    .lt("uploaded_at", cutoff)
    .limit(PASS_C_BATCH);

  let passC = 0;
  let passCMismatches = 0;

  if (selectError) {
    // Pass C select failures log-and-continue rather than throw — Pass A
    // and Pass B already succeeded by this point and the monitor should
    // record success. Pass C is a backstop; missing a single run is not
    // a sweep-level failure.
    logger().error(
      {
        event: "cron.transfer_sweep.pass_c_select_failed",
        error: selectError.message ?? "unknown",
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

  logger().info(
    {
      event: "cron.transfer_sweep.pass_c",
      verified: passC,
      mismatches: passCMismatches,
      durationMs: Date.now() - start,
    },
    "cron.transfer_sweep.pass_c",
  );

  return { passC, passCMismatches };
}

export async function runTransferSweep(
  supabase: SupabaseClient,
  options: { passABatchSize?: number } = {},
): Promise<SweepSummary> {
  const start = Date.now();
  const batchSize = options.passABatchSize ?? PASS_A_BATCH_DEFAULT;
  const passA = await runPassA(supabase, batchSize);
  const passB = await runPassB(supabase);
  const passC = await runPassC(supabase);
  return {
    ...passA,
    passB,
    ...passC,
    durationMs: Date.now() - start,
  };
}
