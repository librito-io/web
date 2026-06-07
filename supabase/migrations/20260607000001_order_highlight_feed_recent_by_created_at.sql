-- Order the 'recent' highlight feed by created_at (authoring time), not
-- updated_at (last-touched time).
--
-- Bug: the Kobo import agent re-POSTs the FULL highlight set every sync
-- (additive + idempotent by design). upsert_kobo_highlights runs ON CONFLICT
-- DO UPDATE, which fires the update_updated_at trigger on EVERY row each sync —
-- including rows whose text/chapter did not change. So after any sync all of a
-- user's Kobo highlights share one updated_at. The 'recent' sort
-- (updated_at DESC, highlight_id DESC) then ties on every row and falls back to
-- the random-UUID tiebreak → arbitrary order, with the newest-authored
-- highlight buried mid-list.
--
-- Fix: 'recent' orders by created_at instead. created_at is the stable
-- authoring time across every source — Kobo DateCreated (forwarded by the
-- agent, INSERT-only in upsert_kobo_highlights so a re-import never rewrites
-- it), and the INSERT-time default for PaperS3 / manual rows. updated_at
-- remains in the return shape (cards still surface it); it is no longer the
-- 'recent' ORDER BY / cursor key.
--
-- This is a CREATE OR REPLACE: the RETURNS TABLE shape is unchanged
-- (book_isbn included, matching 20260503000002), so gen:types is unaffected and
-- existing GRANTs are preserved. Only the 'recent' branch of the filter, the
-- ORDER BY, and the cursor builder change.
--
-- Cursor key for 'recent' changes from 'u' (updated_at) to 'cr' (created_at).
-- The cursor is opaque to the TS layer (encodeCursor/decodeCursor pass JSON
-- through verbatim), so no client code changes. A client mid-scroll across the
-- deploy holding a stale {'u':...} cursor gets one empty page, then recovers on
-- the next fresh load (cursor=NULL) — acceptable, and the same posture the
-- predecessor migration took on cursor-shape changes.
--
-- New supporting index highlights(user_id, created_at DESC, id DESC) mirrors
-- the existing updated_at feed index so the keyset stays index-backed at scale.
-- The old highlights_user_updated_idx is intentionally left in place (it is not
-- this migration's job to audit its remaining users).

CREATE INDEX IF NOT EXISTS highlights_user_created_idx
  ON highlights(user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.get_highlight_feed(
  p_sort       text,
  p_cursor     jsonb,
  p_limit      int,
  p_book_hash  text
)
RETURNS TABLE (
  highlight_id         uuid,
  book_hash            text,
  book_title           text,
  book_author          text,
  book_isbn            text,
  book_highlight_count int,
  chapter_index        smallint,
  chapter_title        text,
  start_word           int,
  end_word             int,
  text                 text,
  styles               text,
  paragraph_breaks     jsonb,
  note_text            text,
  note_updated_at      timestamptz,
  updated_at           timestamptz,
  next_cursor          jsonb
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_uid   uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH counts AS (
    SELECT h.book_id, COUNT(*)::int AS cnt
      FROM highlights h
      JOIN books b ON b.id = h.book_id
     WHERE h.user_id = v_uid
       AND h.deleted_at IS NULL
       AND (p_book_hash IS NULL OR b.book_hash = p_book_hash)
     GROUP BY h.book_id
  ),
  base AS (
    SELECT h.id                        AS highlight_id,
           b.book_hash                 AS book_hash,
           b.title                     AS book_title,
           b.author                    AS book_author,
           b.isbn                      AS book_isbn,
           COALESCE(c.cnt, 0)          AS book_highlight_count,
           h.chapter_index             AS chapter_index,
           h.chapter_title             AS chapter_title,
           h.start_word                AS start_word,
           h.end_word                  AS end_word,
           h.text                      AS text,
           h.styles                    AS styles,
           h.paragraph_breaks          AS paragraph_breaks,
           n.text                      AS note_text,
           n.updated_at                AS note_updated_at,
           h.updated_at                AS updated_at,
           h.created_at                AS created_at
      FROM highlights h
      JOIN books b           ON b.id = h.book_id
      LEFT JOIN notes n      ON n.highlight_id = h.id AND n.deleted_at IS NULL
      LEFT JOIN counts c     ON c.book_id = h.book_id
     WHERE h.user_id = v_uid
       AND h.deleted_at IS NULL
       AND (p_book_hash IS NULL OR b.book_hash = p_book_hash)
  ),
  filtered AS (
    SELECT * FROM base
     WHERE CASE p_sort
       WHEN 'recent' THEN
         p_cursor IS NULL
         OR (created_at, highlight_id) <
            ((p_cursor->>'cr')::timestamptz, (p_cursor->>'id')::uuid)
       WHEN 'title' THEN
         p_cursor IS NULL
         OR (COALESCE(book_title, ''), chapter_index, start_word, highlight_id) >
            (COALESCE(p_cursor->>'t', ''),
             (p_cursor->>'c')::smallint,
             (p_cursor->>'s')::int,
             (p_cursor->>'id')::uuid)
       WHEN 'author' THEN
         p_cursor IS NULL
         OR (COALESCE(book_author, ''), COALESCE(book_title, ''), chapter_index, start_word, highlight_id) >
            (COALESCE(p_cursor->>'a', ''),
             COALESCE(p_cursor->>'t', ''),
             (p_cursor->>'c')::smallint,
             (p_cursor->>'s')::int,
             (p_cursor->>'id')::uuid)
       WHEN 'reading' THEN
         p_cursor IS NULL
         OR (chapter_index, start_word, highlight_id) >
            ((p_cursor->>'c')::smallint,
             (p_cursor->>'s')::int,
             (p_cursor->>'id')::uuid)
       ELSE FALSE
     END
  ),
  ordered AS (
    SELECT *
      FROM filtered
     ORDER BY
       CASE WHEN p_sort = 'recent' THEN created_at END DESC NULLS LAST,
       CASE WHEN p_sort = 'title'   THEN COALESCE(book_title, '')  END ASC,
       CASE WHEN p_sort = 'author'  THEN COALESCE(book_author, '') END ASC,
       CASE WHEN p_sort IN ('title','author') THEN COALESCE(book_title, '') END ASC,
       CASE WHEN p_sort IN ('title','author','reading') THEN chapter_index END ASC,
       CASE WHEN p_sort IN ('title','author','reading') THEN start_word END ASC,
       CASE WHEN p_sort = 'recent' THEN highlight_id END DESC,
       CASE WHEN p_sort IN ('title','author','reading') THEN highlight_id END ASC
     LIMIT v_limit
  ),
  numbered AS (
    SELECT o.*,
           ROW_NUMBER() OVER () AS rn,
           COUNT(*) OVER ()     AS total
      FROM ordered o
  )
  SELECT n.highlight_id,
         n.book_hash,
         n.book_title,
         n.book_author,
         n.book_isbn,
         n.book_highlight_count,
         n.chapter_index,
         n.chapter_title,
         n.start_word,
         n.end_word,
         n.text,
         n.styles,
         n.paragraph_breaks,
         n.note_text,
         n.note_updated_at,
         n.updated_at,
         CASE
           WHEN n.rn = n.total AND n.total >= v_limit THEN
             CASE p_sort
               WHEN 'recent' THEN
                 jsonb_build_object('cr', n.created_at, 'id', n.highlight_id)
               WHEN 'title' THEN
                 jsonb_build_object('t', COALESCE(n.book_title, ''),
                                    'c', n.chapter_index,
                                    's', n.start_word,
                                    'id', n.highlight_id)
               WHEN 'author' THEN
                 jsonb_build_object('a', COALESCE(n.book_author, ''),
                                    't', COALESCE(n.book_title, ''),
                                    'c', n.chapter_index,
                                    's', n.start_word,
                                    'id', n.highlight_id)
               WHEN 'reading' THEN
                 jsonb_build_object('c', n.chapter_index,
                                    's', n.start_word,
                                    'id', n.highlight_id)
               ELSE NULL::jsonb
             END
           ELSE NULL::jsonb
         END AS next_cursor
    FROM numbered n
   ORDER BY n.rn;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_highlight_feed(text, jsonb, int, text) TO authenticated;
