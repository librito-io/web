-- ============================================================
-- get_library: one row per book for the current user, with
-- highlight count and last highlight activity.
-- ============================================================
CREATE OR REPLACE FUNCTION get_library()
RETURNS TABLE (
  id              uuid,
  book_hash       text,
  title           text,
  author          text,
  language        text,
  isbn            text,
  updated_at      timestamptz,
  highlight_count bigint,
  last_activity   timestamptz
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    b.id,
    b.book_hash,
    b.title,
    b.author,
    b.language,
    b.isbn,
    b.updated_at,
    COUNT(h.id) FILTER (WHERE h.deleted_at IS NULL) AS highlight_count,
    MAX(h.updated_at) FILTER (WHERE h.deleted_at IS NULL) AS last_activity
  FROM books b
  LEFT JOIN highlights h ON h.book_id = b.id
  WHERE b.user_id = auth.uid()
  GROUP BY b.id
  ORDER BY last_activity DESC NULLS LAST, b.updated_at DESC;
$$;

COMMENT ON FUNCTION get_library() IS 'Dashboard query: books + highlight counts + last activity for the current user.';

GRANT EXECUTE ON FUNCTION get_library() TO authenticated;

-- ============================================================
-- get_book_with_highlights: one book + all non-deleted
-- highlights and notes in a single round trip. Returns JSON.
-- ============================================================
CREATE OR REPLACE FUNCTION get_book_with_highlights(p_book_hash text)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH book_row AS (
    SELECT id, book_hash, title, author, language, isbn, updated_at
    FROM books
    WHERE user_id = auth.uid() AND book_hash = p_book_hash
    LIMIT 1
  ),
  hl_rows AS (
    SELECT h.id,
           h.chapter_index,
           h.chapter_title,
           h.start_word,
           h.end_word,
           h.text,
           h.styles,
           h.paragraph_breaks,
           h.updated_at,
           n.text AS note_text,
           n.updated_at AS note_updated_at
    FROM highlights h
    LEFT JOIN notes n ON n.highlight_id = h.id
    WHERE h.book_id = (SELECT id FROM book_row)
      AND h.user_id = auth.uid()
      AND h.deleted_at IS NULL
    ORDER BY h.chapter_index ASC, h.start_word ASC
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM book_row) THEN NULL::jsonb
    ELSE jsonb_build_object(
      'book', to_jsonb((SELECT br FROM book_row br)),
      'highlights', COALESCE(
        (SELECT jsonb_agg(to_jsonb(hr)) FROM hl_rows hr),
        '[]'::jsonb
      )
    )
  END;
$$;

COMMENT ON FUNCTION get_book_with_highlights(text) IS 'Book detail payload: book row + non-deleted highlights and notes.';

GRANT EXECUTE ON FUNCTION get_book_with_highlights(text) TO authenticated;
