-- WS-RT: notes tombstones + Realtime publication enablement.
-- Spec: docs/superpowers/specs/2026-04-26-ws-rt-realtime-token-and-tombstones.md
-- Additive only. Existing rows: deleted_at IS NULL ("live"), matching current semantics.

-- 1. Soft-delete column on notes. Mirrors highlights.deleted_at shape.
--    Tombstone surface for Realtime UPDATE events; doubles as the
--    primitive for a future web-app "Move to Trash" UX (out of WS-RT scope).
ALTER TABLE public.notes
  ADD COLUMN deleted_at timestamptz;

COMMENT ON COLUMN public.notes.deleted_at IS
  'Soft-delete marker. NULL = live. Non-null = trashed. Retention target 30 d via follow-up "Empty Trash" cron (see WS-RT spec §14.1).';

-- 2. Partial index for trash-view queries and the eventual hard-delete sweep.
CREATE INDEX idx_notes_deleted_at
  ON public.notes (user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 3. Realtime payload widening. Default REPLICA IDENTITY emits only the
--    primary key on UPDATE/DELETE — useless for the device which keys
--    notes by highlight composite key, not by notes.id. FULL emits the
--    whole pre-image so a future client-side optimization can derive
--    composite keys without a round trip. WS-RT itself does not enable
--    that optimization (device always re-fetches via /api/sync), but
--    FULL is cheap insurance.
ALTER TABLE public.notes REPLICA IDENTITY FULL;
ALTER TABLE public.book_transfers REPLICA IDENTITY FULL;

-- 4. Add tables to the supabase_realtime publication. The default
--    publication is empty in this project (no migration adds tables
--    today). Without this step, Realtime emits nothing for these tables.
ALTER PUBLICATION supabase_realtime ADD TABLE public.notes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.book_transfers;
