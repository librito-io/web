-- 20260528000002_cover_source_openlibrary_work.sql
--
-- Widen book_catalog.cover_source CHECK to allow 'openlibrary_work', the
-- cover_source written when the work-resolver's WorkCoverWalker resolves a
-- cover from the chosen work's cover editions. See work-resolver design
-- 2026-05-31 (#451/#470).

ALTER TABLE public.book_catalog
  DROP CONSTRAINT IF EXISTS book_catalog_cover_source_chk;

ALTER TABLE public.book_catalog
  ADD CONSTRAINT book_catalog_cover_source_chk
  CHECK (
    cover_source IS NULL
    OR cover_source = ANY (
      ARRAY[
        'openlibrary_isbn_direct',
        'openlibrary_isbn',
        'openlibrary_search_title',
        'openlibrary_work',
        'google_books',
        'itunes',
        'manual'
      ]::text[]
    )
  );
