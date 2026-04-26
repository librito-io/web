-- WS-D: extend expire-stale-transfers to cover failed rows so failed-row
-- Storage objects flow through the existing scrub + sweep pipeline.
-- Without this, failed rows leak Storage objects indefinitely.
-- Spec: docs/superpowers/specs/2026-04-25-ws-d-transfer-retry-ui.md §8.

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'expire-stale-transfers';

SELECT cron.schedule(
  'expire-stale-transfers',
  '0 * * * *',
  $$
    UPDATE public.book_transfers
    SET status = 'expired'
    WHERE status IN ('pending', 'failed')
      AND uploaded_at < now() - interval '48 hours';
  $$
);
