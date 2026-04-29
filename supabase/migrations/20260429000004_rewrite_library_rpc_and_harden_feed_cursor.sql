-- PR 5 — Supabase audit 2026-04-29: P1, P2, L1 (one bundle, two functions touched).
--
-- P1: get_library_with_highlights called bare auth.uid() twice in correlated
--     subqueries. SECURITY INVOKER SQL functions re-evaluate auth.uid() per
--     scanned row — same advisor class that 20260427000004 fixed for RLS
--     policies. Convert to plpgsql and cache once via `v_uid uuid := auth.uid()`,
--     mirroring get_highlight_feed (20260415000002:54).
--
-- P2: same function aggregated highlights via a per-book correlated subquery
--     in the book_rows CTE (N+1: 50 books × 1k users = 50k subquery
--     invocations per concurrent wave). Replace with LEFT JOIN LATERAL so the
--     planner can hash/merge-join on idx_highlights_book.
--
-- L1: get_highlight_feed cursor pagination dropped books with NULL book_title
--     or book_author. Tuple compare `(NULL, ...) > (cursor, ...)` evaluates
--     UNKNOWN, filtering the row out — books with missing EPUB metadata
--     became invisible to pagination after the first page that crossed them.
--     Wrap both the cursor comparison AND the ORDER BY CASE in
--     COALESCE(book_title, '') / COALESCE(book_author, ''), and also wrap the
--     cursor *generation* sites so emit-and-consume agree (empty string,
--     never JSON null).
--
-- Bundled because all three changes touch the same two functions and ship
-- together cleanly. Precedent for the auth.uid() wrapping pattern is
-- 20260427000004 — this PR extends that pattern from RLS policies into
-- function bodies.

-- ---------------------------------------------------------------------------
-- P1 + P2: get_library_with_highlights — plpgsql + cached uid + LATERAL
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_library_with_highlights();

CREATE OR REPLACE FUNCTION public.get_library_with_highlights()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',            bo.id,
        'book_hash',     bo.book_hash,
        'title',         bo.title,
        'author',        bo.author,
        'language',      bo.language,
        'isbn',          bo.isbn,
        'last_activity', bo.last_activity,
        'highlights',    COALESCE(hl.highlights, '[]'::jsonb)
      )
      ORDER BY bo.last_activity DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO v_out
  FROM (
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
     WHERE b.user_id = v_uid
  ) bo
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'id',              h.id,
               'chapter_index',   h.chapter_index,
               'chapter_title',   h.chapter_title,
               'start_word',      h.start_word,
               'end_word',        h.end_word,
               'text',            h.text,
               'styles',          h.styles,
               'paragraph_breaks', h.paragraph_breaks,
               'updated_at',      h.updated_at,
               'note_text',       n.text,
               'note_updated_at', n.updated_at
             )
             ORDER BY h.chapter_index ASC, h.start_word ASC
           ) AS highlights
      FROM highlights h
      LEFT JOIN notes n
             ON n.highlight_id = h.id
            AND n.deleted_at IS NULL
     WHERE h.book_id = bo.id
       AND h.user_id = v_uid
       AND h.deleted_at IS NULL
  ) hl ON true;

  RETURN v_out;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_library_with_highlights() TO authenticated;

-- ---------------------------------------------------------------------------
-- L1: get_highlight_feed — COALESCE-wrap NULL title/author at compare, order,
-- and cursor-build sites so missing-metadata books paginate.
-- ---------------------------------------------------------------------------

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
       CASE WHEN p_sort = 'recent' THEN updated_at END DESC NULLS LAST,
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
