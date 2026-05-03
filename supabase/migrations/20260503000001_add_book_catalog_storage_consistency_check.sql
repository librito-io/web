-- Couple storage_path and cover_storage_backend so they are either both NULL
-- (negative cache row -- cover lookup attempted, no cover available) or both
-- non-null (positive row with stored cover). Single-side NULL would lie to
-- the type system: BookCatalogRow's discriminated union assumes this
-- coupling holds.
ALTER TABLE book_catalog
  ADD CONSTRAINT book_catalog_storage_consistency
  CHECK (
    (storage_path IS NULL AND cover_storage_backend IS NULL)
    OR
    (storage_path IS NOT NULL AND cover_storage_backend IS NOT NULL)
  );

COMMENT ON CONSTRAINT book_catalog_storage_consistency ON book_catalog IS
  'Storage coupling invariant: storage_path and cover_storage_backend are either both NULL (negative cache) or both non-null (positive). Lifted into TypeScript as a discriminated BookCatalogRow union with the hasCoverStorage type guard.';
