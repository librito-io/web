-- ============================================================
-- get_library_with_highlights: every book the current user owns
-- plus its non-deleted highlights and notes, embedded in a single
-- JSONB array. Sorted by last highlight activity desc, nulls last.
-- ============================================================
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
                LEFT JOIN notes n ON n.highlight_id = h.id
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

COMMENT ON FUNCTION get_library_with_highlights() IS
  'Library payload: all books for current user with non-deleted highlights and notes embedded.';

GRANT EXECUTE ON FUNCTION get_library_with_highlights() TO authenticated;
