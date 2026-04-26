-- WS-RT: patch get_library_with_highlights + get_highlight_feed so soft-deleted
-- notes (notes.deleted_at IS NOT NULL, introduced in 20260426000001) do not
-- leak into the browser library or feed views. Both RPCs LEFT JOIN notes
-- without a deleted_at predicate; without this patch a deleted note still
-- shows its text in the UI until it is hard-deleted.
--
-- Strategy: re-`CREATE OR REPLACE` both functions verbatim from their last
-- shipped definitions, with a single added `AND n.deleted_at IS NULL` clause
-- in the LEFT JOIN ON-clause. SECURITY INVOKER + GRANT EXECUTE preserved.

CREATE OR REPLACE FUNCTION get_library_with_highlights()
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH books_ordered AS (
    SELECT b.id,
           b.book_hash,
           b.title,
           b.author,
           b.language,
           b.isbn,
           b.updated_at,
           COALESCE(
             (SELECT MAX(h.updated_at)
                FROM highlights h
               WHERE h.book_id = b.id
                 AND h.deleted_at IS NULL),
             b.updated_at
           ) AS last_activity
      FROM books b
     WHERE b.user_id = auth.uid()
  ),
  book_rows AS (
    SELECT bo.id,
           bo.book_hash,
           bo.title,
           bo.author,
           bo.language,
           bo.isbn,
           bo.last_activity,
           COALESCE(
             (SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', h.id,
                         'chapter_index', h.chapter_index,
                         'chapter_title', h.chapter_title,
                         'start_word', h.start_word,
                         'end_word', h.end_word,
                         'text', h.text,
                         'styles', h.styles,
                         'paragraph_breaks', h.paragraph_breaks,
                         'updated_at', h.updated_at,
                         'note_text', n.text,
                         'note_updated_at', n.updated_at
                       )
                       ORDER BY h.chapter_index ASC, h.start_word ASC
                     )
                FROM highlights h
                LEFT JOIN notes n
                       ON n.highlight_id = h.id
                      AND n.deleted_at IS NULL
               WHERE h.book_id = bo.id
                 AND h.user_id = auth.uid()
                 AND h.deleted_at IS NULL),
             '[]'::jsonb
           ) AS highlights
      FROM books_ordered bo
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', br.id,
        'book_hash', br.book_hash,
        'title', br.title,
        'author', br.author,
        'language', br.language,
        'isbn', br.isbn,
        'last_activity', br.last_activity,
        'highlights', br.highlights
      )
      ORDER BY br.last_activity DESC NULLS LAST
    ),
    '[]'::jsonb
  )
    FROM book_rows br;
$$;

GRANT EXECUTE ON FUNCTION get_library_with_highlights() TO authenticated;

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

GRANT EXECUTE ON FUNCTION get_highlight_feed(text, jsonb, int, text) TO authenticated;
