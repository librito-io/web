-- ============================================================
-- pairing_codes.poll_secret_hash → NOT NULL (phase 3 cutover)
-- ============================================================
-- Phase 3 of issue #286 step 2. Phase 2 (migration 20260520000002)
-- added the column as NULLable so rows minted before that migration
-- deployed could expire naturally through PAIRING_CODE_TTL_SEC
-- (300s). Reader firmware now ships with the pollSecret forwarder
-- (librito-io/reader#46), so /api/pair/status callers always
-- present a secret; the NULL admission path in the status handler
-- is removed.
--
-- Any NULL row at this point was minted before 20260520000002
-- deployed and is at minimum hours past TTL — refuse-then-delete
-- is loss-free. The DELETE runs before SET NOT NULL so a stale
-- NULL row cannot trip the alter.
--
-- The existing CHECK constraint already validates the 64-char
-- lowercase hex shape via `poll_secret_hash IS NULL OR ...`. The
-- NOT NULL constraint makes the NULL leg unreachable; we leave the
-- check as-is rather than rewrite it (defensive belt-and-braces;
-- no schema-rename churn).

DELETE FROM public.pairing_codes WHERE poll_secret_hash IS NULL;

ALTER TABLE public.pairing_codes
  ALTER COLUMN poll_secret_hash SET NOT NULL;

COMMENT ON COLUMN public.pairing_codes.poll_secret_hash IS
  'SHA-256 hex (lowercase, 64 chars) of the per-pairing pollSecret '
  'minted by /api/pair/request and returned once to the device. '
  'Required by /api/pair/status to authenticate the polling caller. '
  'NOT NULL post-20260520000004 — the rollout window for the phase-2 '
  'NULLable form closed once reader firmware shipped the forwarder. '
  'See issue #286 / #319.';
