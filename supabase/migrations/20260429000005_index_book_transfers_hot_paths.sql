-- Add four indexes to book_transfers covering the cron and sync hot paths
-- (audit PR 6: P3, P4, P5 — folded together because P4's predicate is a
-- subset of P3's broader partial index).
--
-- Background: /repo-review on 2026-04-29 surfaced three book_transfers
-- queries that fall through to seq scan or partial-fit indexes today.
-- Pre-launch row counts make this invisible; at the 1k-user scaling
-- target each query becomes a hot path.
--
-- Audit-body errata: the audit body claimed P3's
-- idx_transfers_unscrubbable_uploaded (status IN ('pending','failed'))
-- "covered the scrub-retired-transfers expired branch" by subset. That
-- claim is false — 'expired' is not in ('pending','failed'). A
-- self-review caught the gap mid-PR; rather than defer to a follow-up,
-- we add a fourth index symmetric to the downloaded-branch partial,
-- so this PR ships full coverage of every cron + sync hot-path
-- predicate touching book_transfers.
--
-- Query 1 — pg_cron 'expire-stale-transfers' (every hour, superuser):
--   UPDATE book_transfers
--   SET status = 'expired'
--   WHERE status IN ('pending', 'failed')
--     AND uploaded_at < now() - interval '48 hours';
--
--   The existing idx_transfers_device (device_id, status) leads with
--   device_id and is useless for status-first scans. No other index
--   covers this predicate. Partial index on uploaded_at filtered to
--   the unscrubbable statuses keeps it tiny and exactly scoped.
--   → idx_transfers_unscrubbable_uploaded
--
-- Query 2 — pg_cron 'scrub-retired-transfers' (every hour, superuser),
--   downloaded branch (after PR 3's rewrite to make the Vercel sweep
--   own storage_path nulling):
--     UPDATE book_transfers
--     SET filename = NULL, sha256 = NULL, scrubbed_at = now()
--     WHERE scrubbed_at IS NULL
--       AND storage_path IS NULL
--       AND status = 'downloaded' AND downloaded_at < now() - 24h;
--
--   The existing idx_transfers_scrubbed (scrubbed_at) WHERE
--   scrubbed_at IS NOT NULL is the reverse partial — covers the
--   Vercel sweep's hard-delete pass, not this scrub. Partial index
--   on downloaded_at filtered to (scrubbed_at IS NULL AND
--   status = 'downloaded') exactly covers the downloaded branch.
--   → idx_transfers_downloaded_unscrubbed
--
-- Query 3 — pg_cron 'scrub-retired-transfers', expired branch:
--     UPDATE book_transfers
--     SET filename = NULL, sha256 = NULL, scrubbed_at = now()
--     WHERE scrubbed_at IS NULL
--       AND storage_path IS NULL
--       AND status = 'expired' AND uploaded_at < now() - 49h;
--
--   Symmetric to query 2 but ages by uploaded_at (downloaded_at is
--   NULL for never-downloaded rows). Working set is small at current
--   scale — rows enter 'expired' via expire-stale-transfers (gated
--   on 48h uploaded_at) then get scrubbed within ~1h, so the partial
--   will be tiny — but indexing it now keeps the cron's plan stable
--   under any future scrub-cadence change or backlog scenario.
--   → idx_transfers_expired_unscrubbed
--
-- Query 4 — /api/sync hot path (per device per ~30s sync interval):
--   SELECT id, filename, file_size, storage_path, sha256
--     FROM book_transfers
--    WHERE user_id = X AND status = 'pending'
--      AND (device_id = D OR device_id IS NULL);
--
--   plus a paired SELECT count WHERE user_id = X AND status = 'failed'.
--   At 1k devices × 30s = 33 q/s. The existing idx_transfers_user
--   (user_id) covers user_id only — Postgres scans all that user's
--   rows then filters status in memory. A composite (user_id, status)
--   removes the in-memory filter and matches the FK-coverage style
--   shipped in 20260427000005.
--   → idx_transfers_user_status
--
-- Cost: four index entries per write to book_transfers. Writes happen
-- on initiate, status transitions (per device sync), scrub, and sweep.
-- At 1k users the write rate is well under 1 q/s; the index overhead
-- is in the noise.
--
-- Locking note: CREATE INDEX (non-CONCURRENTLY) takes a brief
-- ACCESS EXCLUSIVE lock on book_transfers. Production row count is
-- under a few thousand today; the lock will be sub-second. We cannot
-- use CONCURRENTLY here because the Supabase migration runner wraps
-- each migration in a transaction by default and CONCURRENTLY cannot
-- run inside a transaction. Revisit if the table grows past ~100k.
--
-- Release: this migration does NOT auto-deploy to production. Per
-- CLAUDE.md "Release Process", run `supabase migration list` and
-- `supabase db push` against production after the squash merge lands.

-- P3: covers expire-stale-transfers status IN ('pending', 'failed')
-- AND uploaded_at < cutoff.
CREATE INDEX IF NOT EXISTS idx_transfers_unscrubbable_uploaded
  ON public.book_transfers (uploaded_at)
  WHERE status IN ('pending', 'failed');

-- P4 (folded into P3): covers scrub-retired-transfers downloaded
-- branch (scrubbed_at IS NULL AND status = 'downloaded' AND
-- downloaded_at < cutoff). Subsumes the standalone "IS NULL on
-- scrubbed_at" index proposed by P4 — that index would cover the
-- whole table; this partial covers exactly the rows the cron touches.
CREATE INDEX IF NOT EXISTS idx_transfers_downloaded_unscrubbed
  ON public.book_transfers (downloaded_at)
  WHERE scrubbed_at IS NULL AND status = 'downloaded';

-- P3 expired-branch coverage (added on second pass — see audit-body
-- errata above). Symmetric to idx_transfers_downloaded_unscrubbed but
-- keyed on uploaded_at, since the expired branch ages by uploaded_at
-- (downloaded_at is NULL for never-downloaded rows).
CREATE INDEX IF NOT EXISTS idx_transfers_expired_unscrubbed
  ON public.book_transfers (uploaded_at)
  WHERE scrubbed_at IS NULL AND status = 'expired';

-- P5: covers /api/sync's per-user, per-status filters.
CREATE INDEX IF NOT EXISTS idx_transfers_user_status
  ON public.book_transfers (user_id, status);
