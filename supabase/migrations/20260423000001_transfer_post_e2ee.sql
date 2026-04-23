-- WS-A: post-E2EE consolidation.
-- Spec: docs/superpowers/specs/2026-04-22-transfer-schema-consolidation-design.md
-- Preconditions: Deploy 1 has been live >= ~2 h and no pending_upload rows remain.

-- 1. Safety gate.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.book_transfers WHERE status = 'pending_upload') > 0 THEN
    RAISE EXCEPTION 'Drain window incomplete: % pending_upload rows remain',
      (SELECT count(*) FROM public.book_transfers WHERE status = 'pending_upload');
  END IF;
END $$;

-- 2. New columns.
ALTER TABLE public.book_transfers
  ADD COLUMN attempt_count int NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN scrubbed_at timestamptz;

-- 3. Relax columns so scrub can NULL them.
ALTER TABLE public.book_transfers
  ALTER COLUMN sha256 DROP NOT NULL,
  ALTER COLUMN filename DROP NOT NULL,
  ALTER COLUMN storage_path DROP NOT NULL;

-- 3.5. Normalise legacy empty-sha rows (pre-refactor detritus) to the scrubbed
-- state, so the tightened valid_sha256 CHECK below does not abort.
UPDATE book_transfers
SET sha256 = NULL,
    filename = NULL,
    storage_path = NULL,
    scrubbed_at = now()
WHERE sha256 = '';

-- 4. Tighten valid_transfer_status — drop pending_upload, add failed.
ALTER TABLE public.book_transfers
  DROP CONSTRAINT valid_transfer_status,
  ADD CONSTRAINT valid_transfer_status
    CHECK (status IN ('pending', 'downloaded', 'expired', 'failed'));

-- 5. Rework valid_sha256 — 64-hex OR NULL on a scrubbed row.
ALTER TABLE public.book_transfers
  DROP CONSTRAINT valid_sha256,
  ADD CONSTRAINT valid_sha256
    CHECK (
      sha256 ~ '^[0-9a-f]{64}$'
      OR (scrubbed_at IS NOT NULL AND sha256 IS NULL)
    );

-- 6. Partial unique index — catches concurrent-initiate race.
CREATE UNIQUE INDEX idx_transfers_dedup_pending
  ON public.book_transfers (user_id, sha256)
  WHERE status = 'pending' AND sha256 IS NOT NULL;

-- 7. Index for hard-delete sweep pass.
CREATE INDEX idx_transfers_scrubbed
  ON public.book_transfers (scrubbed_at)
  WHERE scrubbed_at IS NOT NULL;

-- 8. pg_cron rewrites. Using the jobid-select form so re-running the migration
-- in a broken state does not error if a job already got removed.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'expire-abandoned-uploads';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'expire-stale-transfers';

SELECT cron.schedule(
  'expire-stale-transfers',
  '0 * * * *',
  $$
    UPDATE public.book_transfers
    SET status = 'expired'
    WHERE status = 'pending'
      AND uploaded_at < now() - interval '48 hours';
  $$
);

SELECT cron.schedule(
  'scrub-retired-transfers',
  '0 * * * *',
  $$
    UPDATE public.book_transfers
    SET filename = NULL,
        sha256 = NULL,
        storage_path = NULL,
        scrubbed_at = now()
    WHERE scrubbed_at IS NULL
      AND (
        (status = 'downloaded' AND downloaded_at < now() - interval '24 hours')
        OR (status = 'expired' AND uploaded_at < now() - interval '49 hours')
      );
  $$
);
