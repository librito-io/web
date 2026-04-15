-- ============================================================
-- Phase 4.1: flat highlight feed RPC
-- One row per highlight. Keyset pagination via p_cursor (jsonb).
-- Shape of cursor depends on p_sort:
--   recent:  {"u":"<iso>","id":"<uuid>"}
--   title:   {"t":"<title>","c":<ch>,"s":<sw>,"id":"<uuid>"}
--   author:  {"a":"<author>","t":"<title>","c":<ch>,"s":<sw>,"id":"<uuid>"}
--   reading: {"c":<ch>,"s":<sw>,"id":"<uuid>"}
-- next_cursor is non-null ONLY on the final row when more pages remain.
-- Non-final rows always carry NULL next_cursor; client reads rows.at(-1).
-- ============================================================

DROP FUNCTION IF EXISTS get_library_with_highlights();

CREATE INDEX IF NOT EXISTS highlights_user_updated_idx
  ON highlights(user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS highlights_user_reading_idx
  ON highlights(user_id, book_id, chapter_index, start_word, id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION get_highlight_feed(
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
           h.updated_at                AS updated_at
      FROM highlights h
      JOIN books b           ON b.id = h.book_id
      LEFT JOIN notes n      ON n.highlight_id = h.id
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
         OR (updated_at, highlight_id) <
            ((p_cursor->>'u')::timestamptz, (p_cursor->>'id')::uuid)
       WHEN 'title' THEN
         p_cursor IS NULL
         OR (book_title, chapter_index, start_word, highlight_id) >
            (p_cursor->>'t',
             (p_cursor->>'c')::smallint,
             (p_cursor->>'s')::int,
             (p_cursor->>'id')::uuid)
       WHEN 'author' THEN
         p_cursor IS NULL
         OR (book_author, book_title, chapter_index, start_word, highlight_id) >
            (p_cursor->>'a',
             p_cursor->>'t',
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
       CASE WHEN p_sort = 'recent' THEN updated_at END DESC NULLS LAST,
       CASE WHEN p_sort = 'title'   THEN book_title END ASC NULLS LAST,
       CASE WHEN p_sort = 'author'  THEN book_author END ASC NULLS LAST,
       CASE WHEN p_sort IN ('title','author') THEN book_title END ASC NULLS LAST,
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
                 jsonb_build_object('u', n.updated_at, 'id', n.highlight_id)
               WHEN 'title' THEN
                 jsonb_build_object('t', n.book_title,
                                    'c', n.chapter_index,
                                    's', n.start_word,
                                    'id', n.highlight_id)
               WHEN 'author' THEN
                 jsonb_build_object('a', n.book_author,
                                    't', n.book_title,
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

COMMENT ON FUNCTION get_highlight_feed(text, jsonb, int, text) IS
  'Phase 4.1 flat highlight feed. Keyset pagination over (sort, cursor). book_hash null = full feed.';

GRANT EXECUTE ON FUNCTION get_highlight_feed(text, jsonb, int, text) TO authenticated;
