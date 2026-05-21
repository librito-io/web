-- Rename cover_cache_pkey to book_catalog_pkey.
--
-- The cover_cache → book_catalog table rename in
-- 20260502000001_rename_cover_cache_to_book_catalog.sql left the primary key
-- with its original name. PostgreSQL preserves index/constraint names through
-- ALTER TABLE ... RENAME, so the pkey is the lone holdout — every other index
-- on the table already follows the book_catalog_* naming pattern. Cosmetic
-- only; no query planning, RLS, or code impact (code references SQL relation
-- names, not index names).
--
-- ALTER TABLE RENAME CONSTRAINT renames both the constraint and its
-- supporting index in one statement (verified locally on PG 17.6).
--
-- Closes #97.

ALTER TABLE public.book_catalog
  RENAME CONSTRAINT cover_cache_pkey TO book_catalog_pkey;
