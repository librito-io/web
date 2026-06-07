-- upsert_kobo_highlights — gate the DO UPDATE so unchanged rows skip the write.
--
-- librito-io/web#512. The Kobo agent re-POSTs the FULL highlight set on every
-- sync (by design, additive + idempotent). The original RPC's
-- ON CONFLICT DO UPDATE wrote every row unconditionally, firing the
-- update_updated_at trigger even when text + chapter_title were byte-identical:
-- N row writes + N WAL records + N Realtime change events for zero real change.
-- The agent's resident watch daemon (kobo-agent#18) syncs on every new
-- highlight while connected, so a 5-highlight reading session over 200 existing
-- highlights drove ~1000 writes for 5 genuinely-new rows. This collapses that.
--
-- The WHERE on the DO UPDATE branch makes Postgres skip the row write (and the
-- trigger) when no meaningful column changed; unchanged rows keep their
-- updated_at, genuine INSERTs and genuine edits still write. IS DISTINCT FROM
-- (not <>) is required so a NULL chapter_title compares correctly. Only the two
-- mutable columns are gated — the SET already touches only text + chapter_title;
-- book-level / immutable / server-owned columns (user_id, source, created_at,
-- deleted_at, word-index fields) are never in the SET, so the conditional
-- cannot disturb the server-owned soft-delete (a web-trashed highlight that the
-- agent re-POSTs unchanged is not rewritten, so deleted_at stays set).
--
-- Pure body change; signature, grants, and every other invariant (p_user_id
-- pinned server-side, source forced 'kobo', created_at INSERT-only) are
-- unchanged from 20260604000002. See that migration for the full rationale.
CREATE OR REPLACE FUNCTION public.upsert_kobo_highlights(p_user_id uuid, p_rows jsonb)
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
    WHERE highlights.text          IS DISTINCT FROM EXCLUDED.text
       OR highlights.chapter_title IS DISTINCT FROM EXCLUDED.chapter_title
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;

-- CREATE OR REPLACE preserves existing grants; re-assert the two-REVOKE
-- template so the function stays self-contained (service_role only).
REVOKE EXECUTE ON FUNCTION public.upsert_kobo_highlights(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_kobo_highlights(uuid, jsonb) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_kobo_highlights(uuid, jsonb) TO service_role;
