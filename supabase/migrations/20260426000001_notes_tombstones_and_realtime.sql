-- WS-RT: notes tombstones + Realtime publication enablement.
-- Spec: librito-io/reader docs/superpowers/specs/2026-04-26-ws-rt-realtime-token-and-tombstones.md
-- Additive only. Existing rows: deleted_at IS NULL ("live"), matching current semantics.
--
-- Idempotency: guards on every operation so the migration is safe to re-run
-- against an environment where Realtime was toggled in the Supabase dashboard
-- before the migration ran (a common scenario for forks and self-hosters).

-- 1. Soft-delete column on notes. Mirrors highlights.deleted_at shape.
--    Tombstone surface for Realtime UPDATE events; doubles as the
--    primitive for a future web-app "Move to Trash" UX (out of WS-RT scope).
ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.notes.deleted_at IS
  'Soft-delete marker. NULL = live. Non-null = trashed. Hard-deleted after 30 d by the empty-trashed-notes pg_cron job below.';

-- 2. Partial index for trash-view queries and the hard-delete sweep.
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at
  ON public.notes (user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 3. Realtime payload widening on notes. Default REPLICA IDENTITY emits only
--    the primary key on UPDATE/DELETE — useless for the device which keys
--    notes by highlight composite key, not by notes.id. FULL emits the whole
--    pre-image so a future client-side optimization can derive composite keys
--    without a round trip. WS-RT itself does not enable that optimization
--    (device always re-fetches via /api/sync), but FULL is cheap insurance.
ALTER TABLE public.notes REPLICA IDENTITY FULL;

-- 4. Add notes to the supabase_realtime publication. The default publication
--    is empty in this project. Without this step, Realtime emits nothing.
--    Wrapped in a pg_publication_tables guard so the migration is safe to
--    re-run if the table was already added (e.g. via the dashboard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notes;
  END IF;
END $$;

-- 5. Hard-delete trashed notes after 30 days. Bounds tombstone growth and
--    keeps the deletedNotes[] payload in /api/sync from accumulating
--    forever. Uses the unschedule + reschedule form per the project's
--    pg_cron convention (see 20260423000001_transfer_post_e2ee.sql).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'empty-trashed-notes';

SELECT cron.schedule(
  'empty-trashed-notes',
  '0 3 * * *',
  $$
    DELETE FROM public.notes
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - interval '30 days';
  $$
);
