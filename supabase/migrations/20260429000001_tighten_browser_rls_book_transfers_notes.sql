-- Tighten browser-side RLS on book_transfers and notes (audit PR 2: S1, S2, S5).
--
-- Background: /repo-review on 2026-04-29 surfaced three browser-reachable RLS
-- holes that bypass invariants the API routes already enforce server-side:
--
--   S1  book_transfers INSERT policy lets authenticated browsers POST to
--       /rest/v1/book_transfers with arbitrary status/filename/size/sha256,
--       sidestepping the MAX_PENDING_TRANSFERS quota, the @upstash/ratelimit
--       cap, and the filename/size/mime validation in
--       /api/transfer/initiate. The Storage upload itself is gated
--       independently (see S2), but DB row pollution is real — phantom rows
--       count against any future per-user quota and waste pg_cron cycles.
--
--   S2  storage.objects "Users can upload book transfers" only validates the
--       path's first segment (user_id) — the {transfer_id} segment is
--       unchecked, so an authenticated user can upload up to 50 MB to any
--       {their_user_id}/<random-uuid>/<filename> path with no corresponding
--       book_transfers row. Permanent orphans, no scrub trail.
--
--   S5  notes DELETE policy permits hard DELETE via PostgREST. Notes are
--       supposed to use soft-delete (deleted_at column added in
--       20260426000001) so /api/sync's deletedNotes[] response can drive
--       device-side cleanup. A hard DELETE skips the tombstone, so the device
--       never receives the deletion and retains stale text indefinitely. The
--       web app already uses UPDATE deleted_at = now() (see HighlightCard.svelte
--       removeNote, asserted by tests/lib/highlight-card-removenote.test.ts);
--       this migration enforces that contract at the RLS layer so a future
--       contributor reaching for .delete() can't silently regress sync.
--
-- Decisions:
--
--   * S1: drop the INSERT policy outright instead of tightening WITH CHECK.
--     The legitimate path is /api/transfer/initiate, which uses
--     service_role and bypasses RLS. There is no browser caller of
--     book_transfers INSERT today (grep src/ for .from('book_transfers').insert
--     finds only the API route). Dropping is the smaller, more defensible diff
--     than enumerating an allow-list of "safe" initial column values.
--
--   * S2: replace the WITH CHECK with an EXISTS that joins on
--     book_transfers by storage_path's second segment. Using EXISTS with a
--     text comparison (id::text = segment) instead of casting segment::uuid
--     avoids invalid_text_representation errors on malformed paths — the
--     EXISTS just returns false and the policy fails closed cleanly. Signed
--     upload URLs (the legitimate browser path) bypass RLS, so this only
--     affects direct authenticated uploads, which are the abuse vector.
--
--   * S5: drop the DELETE policy. The empty-trashed-notes pg_cron job
--     (20260426000001) runs as superuser and bypasses RLS, so the 30-day
--     hard-delete sweep is unaffected. Web app already migrated to
--     UPDATE deleted_at = now(); locking the policy prevents regression.
--
-- Release: this migration does NOT auto-deploy to production. Per
-- CLAUDE.md "Release Process", run `supabase migration list` and
-- `supabase db push` against production after the squash merge lands.

-- ---- S1: drop browser INSERT on book_transfers ----
DROP POLICY IF EXISTS "Users can create own transfers"
  ON public.book_transfers;

-- ---- S2: tighten storage upload to require a real pending transfer row ----
ALTER POLICY "Users can upload book transfers" ON storage.objects
  WITH CHECK (
    bucket_id = 'book-transfers'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND EXISTS (
      SELECT 1 FROM public.book_transfers t
       WHERE t.id::text = (storage.foldername(name))[2]
         AND t.user_id = (SELECT auth.uid())
         AND t.status = 'pending'
    )
  );

-- ---- S5: drop browser DELETE on notes; lock the soft-delete contract ----
DROP POLICY IF EXISTS "Users can delete own notes" ON public.notes;

COMMENT ON TABLE public.notes IS
  'User notes attached to highlights, created/edited via web app. '
  'Soft-delete via deleted_at — /api/sync deletedNotes[] requires the '
  'tombstone row to remain queryable so the device can hard-delete locally. '
  'Do NOT add an RLS DELETE policy back; use UPDATE deleted_at = now() '
  'in the browser. The empty-trashed-notes pg_cron job runs as superuser '
  'and bypasses RLS, so the 30-day hard-delete sweep is unaffected.';

COMMENT ON TABLE public.book_transfers IS
  'Queue for EPUB transfers from web to device — temporary storage. '
  'INSERT/UPDATE/DELETE are intentionally not granted to authenticated; '
  'all mutations go through API routes using service_role. PostgREST '
  'silently no-ops RLS-blocked writes, so a Supabase JS .insert() / '
  '.update() / .delete() from the browser will appear to succeed. Do not '
  'add browser-side write policies without revisiting the quota / rate-limit '
  '/ status-machine invariants enforced by /api/transfer/*.';
