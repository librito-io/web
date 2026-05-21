-- Drop unused books.cover_path column.
--
-- Added in 20260412000003_create_content_tables.sql as the per-user cover
-- storage path, but no fetcher ever populated it (always NULL in prod). The
-- book detail page reads covers via the books → book_catalog JOIN on isbn
-- and uses book_catalog.storage_path. Column is dead weight; dropping it.
--
-- Closes #88.

ALTER TABLE public.books
  DROP COLUMN IF EXISTS cover_path;
