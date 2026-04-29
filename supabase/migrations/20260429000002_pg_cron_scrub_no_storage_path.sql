-- Re-schedule scrub-retired-transfers so the Vercel transfer-sweep route
-- exclusively owns the storage_path field (audit PR 3: S3).
--
-- Background: /repo-review on 2026-04-29 surfaced a race between two
-- independent retired-row cleaners:
--
--   pg_cron 'scrub-retired-transfers' (every hour, superuser, RLS bypassed)
--     UPDATE book_transfers
--     SET filename = NULL, sha256 = NULL, storage_path = NULL,
--         scrubbed_at = now()
--     WHERE scrubbed_at IS NULL
--       AND ((status='downloaded' AND downloaded_at < now() - 24h)
--         OR (status='expired' AND uploaded_at < now() - 49h));
--
--   Vercel cron 'transfer-sweep' Pass A (every hour, separate scheduler)
--     for each retired row with storage_path NOT NULL:
--       supabase.storage.from('book-transfers').remove([storage_path])
--       supabase.from('book_transfers').update({storage_path: null})
--
-- The two crons fire on overlapping schedules with no ordering guarantee.
-- If pg_cron wins, it nulls storage_path before the Vercel sweep can read
-- it, so the Storage object becomes a permanent orphan — the sweep selects
-- WHERE status IN ('expired','downloaded') AND storage_path IS NOT NULL
-- and skips already-scrubbed rows. Pass A's own comment in
-- src/routes/api/cron/transfer-sweep/+server.ts acknowledges the gap and
-- defers reconciliation to a hypothetical "Pass C" bucket-listing pass.
--
-- Fix: drop storage_path from the pg_cron SET clause, and gate the
-- WHERE on storage_path IS NULL. The Vercel sweep is the only writer that
-- nulls storage_path; pg_cron only scrubs PII (filename, sha256) AFTER the
-- sweep has cleared the path. Stronger invariant — orphans now require
-- both crons to fail (or the Storage delete itself to fail), not a
-- scheduler race. Removes the need for a future bucket-reconciler.
--
-- Failed-status flow is unchanged: 20260425000001's expire-stale-transfers
-- flips 'failed' -> 'expired' after 48 h, which then enters the same
-- retired-row pipeline.
--
-- Release: this migration does NOT auto-deploy to production. Per
-- CLAUDE.md "Release Process", run `supabase migration list` and
-- `supabase db push` against production after the squash merge lands.
-- Use the jobid-select form so re-running on a partially-applied state
-- doesn't error if the job already got removed.

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'scrub-retired-transfers';

SELECT cron.schedule(
  'scrub-retired-transfers',
  '0 * * * *',
  $$
    UPDATE public.book_transfers
    SET filename = NULL,
        sha256 = NULL,
        scrubbed_at = now()
    WHERE scrubbed_at IS NULL
      AND storage_path IS NULL
      AND (
        (status = 'downloaded' AND downloaded_at < now() - interval '24 hours')
        OR (status = 'expired' AND uploaded_at < now() - interval '49 hours')
      );
  $$
);
