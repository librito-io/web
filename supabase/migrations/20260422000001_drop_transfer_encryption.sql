-- Phase 3.5 preparation: drop client-side book transfer encryption.
--
-- Book uploads move to plaintext in Storage (short-lived queue, deleted after
-- device download). Highlights/notes E2EE arrives in a later migration. See
-- docs/superpowers/specs/2026-04-22-e2ee-handover.md in the reader repo for
-- the architectural rationale.
--
-- Any existing pending transfers were encrypted under a browser-side key and
-- cannot be decrypted by firmware that no longer holds the key. Discard them;
-- the user can re-upload. Storage objects for these rows are orphaned on
-- purpose — operators should wipe the book-transfers bucket out-of-band, or
-- let the existing 7-day object TTL / daily expiry job sweep them.

DELETE FROM public.book_transfers;

ALTER TABLE public.book_transfers
  DROP COLUMN IF EXISTS encrypted,
  DROP COLUMN IF EXISTS iv;

ALTER TABLE public.pairing_codes
  DROP COLUMN IF EXISTS transfer_secret;
