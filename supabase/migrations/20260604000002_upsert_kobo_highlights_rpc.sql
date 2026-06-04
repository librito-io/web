-- upsert_kobo_highlights — batch upsert for imported (Kobo) highlights.
--
-- Track 1, Issue 2 (librito-io/web#497). The import dedup key is the PARTIAL
-- unique index highlights_source_uid_key (book_id, source, source_uid)
-- WHERE source_uid IS NOT NULL (migration 20260604000001). PostgREST /
-- supabase-js `.upsert({ onConflict })` cannot thread the partial WHERE
-- predicate, so an ON CONFLICT against the bare column list fails with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- This RPC carries the matching predicate explicitly. Same pattern as the
-- catalog upsert_book_catalog_by_isbn RPC.
--
-- Server-owned soft-delete: the DO UPDATE deliberately does NOT touch
-- deleted_at, so re-importing a highlight the user trashed on the web does
-- not resurrect it (mirrors processSync's omission, sync.ts:341-343).
--
-- Input: p_rows is a JSON array of objects, each
--   { book_id uuid, user_id uuid, source_uid text,
--     text text, chapter_title text|null }.
-- source is forced to 'kobo' server-side; word-index / styles / paragraph
-- columns are left NULL (Kobo highlights are char-offset based). Returns the
-- number of rows inserted-or-updated.
CREATE FUNCTION public.upsert_kobo_highlights(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  WITH input AS (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS r(
      book_id       uuid,
      user_id       uuid,
      source_uid    text,
      text          text,
      chapter_title text
    )
  ),
  upserted AS (
    INSERT INTO public.highlights
      (book_id, user_id, source, source_uid, text, chapter_title)
    SELECT book_id, user_id, 'kobo', source_uid, text, chapter_title
    FROM input
    ON CONFLICT (book_id, source, source_uid) WHERE source_uid IS NOT NULL
    DO UPDATE SET
      text          = EXCLUDED.text,
      chapter_title = EXCLUDED.chapter_title
      -- deleted_at intentionally untouched — server owns soft-delete.
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;

-- service_role only: the import route uses the service-role client. No anon /
-- authenticated caller (two-REVOKE template per CLAUDE.md).
REVOKE EXECUTE ON FUNCTION public.upsert_kobo_highlights(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_kobo_highlights(jsonb) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_kobo_highlights(jsonb) TO service_role;
