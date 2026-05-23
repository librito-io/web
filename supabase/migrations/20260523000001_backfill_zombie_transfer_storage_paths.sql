-- LIBRITO-WEB-9 backfill: null `storage_path` on `downloaded` transfers
-- whose Storage object was already removed by `/confirm`'s best-effort
-- delete but whose `storage_path` was left populated.
--
-- Pre-fix flow: `/api/transfer/[id]/confirm` flipped `status='downloaded'`
-- and called `storage.remove([path])`, but never nulled `storage_path`.
-- The transfer-sweep cron's Pass A then selected those rows daily, called
-- `remove([path])` on already-gone objects, and storage-api returned
-- empty `data` (no top-level error). Pass A counted the empty response as
-- failure → `transfer_sweep_pass_a_storage_failure` fired every fire.
--
-- The companion code change (this PR) makes `/confirm` null `storage_path`
-- on successful Storage removal, closing the loop for future transfers.
-- This migration cleans up the five rows currently stuck in the zombie
-- state. Storage absence for these exact paths was verified out-of-band
-- (`storage.objects WHERE bucket_id='book-transfers' AND name IN (...)`
-- returned zero rows on 2026-05-23) before this migration was authored.
--
-- Idempotent: gated on `storage_path IS NOT NULL`, so re-running this
-- migration (e.g. after a `supabase db reset --local` in CI) is a no-op
-- once the rows are cleared.
--
-- Why the WHERE list of IDs instead of a blanket WHERE clause: scoping
-- to known-investigated rows keeps the blast radius small. A future
-- regression (new writer skipping the null-update) would surface as a
-- fresh Sentry warning with the diagnostic `removeErrorMessage` field
-- (added in the same PR) and merit its own targeted cleanup, not a
-- silent broad sweep here.

UPDATE public.book_transfers
SET storage_path = NULL
WHERE id IN (
  '266488bb-4810-406e-a0d0-37835765c218',
  'e7046c72-d923-459b-bf5c-c94190a508dc',
  'a4ab4eb4-aefa-4f71-bec8-517237b1ddba',
  '06f4f670-a8d7-4c9b-bec6-a39c2599cc17',
  'bda894f4-c495-44ed-8a51-78e9d1a0f6d8'
)
  AND status = 'downloaded'
  AND scrubbed_at IS NULL
  AND storage_path IS NOT NULL;
