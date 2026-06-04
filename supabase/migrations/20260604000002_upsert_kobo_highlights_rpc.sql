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
-- user_id is a SEPARATE pinned parameter (p_user_id), stamped on every row
-- server-side — it is NOT read from p_rows. So even a future JS regression that
-- threaded an attacker-controlled user_id into the payload cannot write rows
-- for another user; the import route already derives p_user_id from the device
-- token (defense in depth, the RPC is service_role-only).
--
-- Server-owned soft-delete: the DO UPDATE deliberately does NOT touch
-- deleted_at, so re-importing a highlight the user trashed on the web does
-- not resurrect it (mirrors processSync's omission, sync.ts:341-343).
-- created_at is likewise INSERT-only (set once from the agent's value or
-- defaulted to now()) — re-import must not rewrite a highlight's origin time.
--
-- Input: p_user_id is the owner; p_rows is a JSON array of objects, each
--   { book_id uuid, source_uid text, text text,
--     chapter_title text|null, created_at timestamptz|null }.
-- source is forced to 'kobo' server-side; word-index / styles / paragraph
-- columns are left NULL (Kobo highlights are char-offset based). Returns the
-- number of rows inserted-or-updated.
CREATE FUNCTION public.upsert_kobo_highlights(p_user_id uuid, p_rows jsonb)
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
      source_uid    text,
      text          text,
      chapter_title text,
      created_at    timestamptz
    )
  ),
  upserted AS (
    INSERT INTO public.highlights
      (book_id, user_id, source, source_uid, text, chapter_title, created_at)
    SELECT
      book_id, p_user_id, 'kobo', source_uid, text, chapter_title,
      COALESCE(created_at, now())
    FROM input
    ON CONFLICT (book_id, source, source_uid) WHERE source_uid IS NOT NULL
    DO UPDATE SET
      text          = EXCLUDED.text,
      chapter_title = EXCLUDED.chapter_title
      -- deleted_at + created_at intentionally untouched — server owns
      -- soft-delete, and a re-import must not rewrite origin time.
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;

-- service_role only: the import route uses the service-role client. No anon /
-- authenticated caller (two-REVOKE template per CLAUDE.md).
REVOKE EXECUTE ON FUNCTION public.upsert_kobo_highlights(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_kobo_highlights(uuid, jsonb) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_kobo_highlights(uuid, jsonb) TO service_role;
