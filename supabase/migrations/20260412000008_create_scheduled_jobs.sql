-- ============================================================
-- SCHEDULED JOBS (pg_cron)
-- ============================================================
-- Automatic cleanup of expired/stale data.
--
-- Note: On Supabase Free tier, the database pauses after 1 week
-- of inactivity. pg_cron jobs won't run while paused — this is
-- fine, they catch up on next wake. The data they clean up is
-- harmless while stale (expired pairing codes can't be claimed,
-- stale transfers stay "pending" until expired).

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Clean up expired pairing codes every 5 minutes.
-- These are short-lived (5 min TTL) and accumulate fast during
-- active pairing sessions.
SELECT cron.schedule(
  'expire-pairing-codes',
  '*/5 * * * *',
  $$DELETE FROM public.pairing_codes WHERE expires_at < now()$$
);

-- Expire stale book transfers daily at midnight UTC.
-- Transfers pending longer than 7 days are marked expired.
-- NOTE: This only updates the DB row status. The actual file in
-- Supabase Storage at book_transfers.storage_path must be deleted
-- separately via an API route or Edge Function (Phase 3/5).
-- SQL cron jobs cannot call the Storage API.
SELECT cron.schedule(
  'expire-stale-transfers',
  '0 0 * * *',
  $$UPDATE public.book_transfers
    SET status = 'expired'
    WHERE status = 'pending'
      AND uploaded_at < now() - interval '7 days'$$
);

-- No cover cache cleanup job. Covers are permanent — fetched once
-- from Open Library/Google Books on first encounter, then stored
-- in Supabase Storage as a shared cover library. All subsequent
-- users with the same ISBN get the cover from our Storage, not
-- from the external API. The cover_cache table grows monotonically
-- (one row per unique ISBN) and is never pruned.
