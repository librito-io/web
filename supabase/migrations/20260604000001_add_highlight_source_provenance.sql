-- Highlight provenance: make the single-source model explicit so Kobo (and
-- later Kindle) highlights can be ingested without polluting the clean
-- word-index device model.
--
-- Track 1, Issue 1 (librito-io/web#496). DB only — no functions, so the
-- EXECUTE REVOKE template does not apply here.
--
-- Imported (non-papers3) rows are char-offset / chapter-path based, NOT
-- word-index based: they carry NULL for start_word / end_word / chapter_index
-- / styles / paragraph_breaks and render as plain quoted text. That is
-- expected. The word-index natural key governs native (papers3) rows only.
--
-- ── Down migration (manual; we do not ship .down.sql) ────────────────────────
--   ALTER TABLE highlights DROP CONSTRAINT papers3_requires_word_index;
--   DROP INDEX highlights_source_uid_key;
--   DROP INDEX highlights_device_natural_key;
--   ALTER TABLE highlights
--     ADD CONSTRAINT highlights_book_id_chapter_index_start_word_end_word_key
--       UNIQUE (book_id, chapter_index, start_word, end_word);
--   -- (Re-adding the NOT NULLs is only safe if no kobo/kindle rows exist.)
--   ALTER TABLE highlights
--     ALTER COLUMN chapter_index SET NOT NULL,
--     ALTER COLUMN start_word    SET NOT NULL,
--     ALTER COLUMN end_word      SET NOT NULL;
--   DROP INDEX idx_books_user_isbn;
--   ALTER TABLE highlights DROP COLUMN source_uid, DROP COLUMN source;
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Provenance columns. Existing rows backfill to 'papers3' via the default.
ALTER TABLE highlights
  ADD COLUMN source text NOT NULL DEFAULT 'papers3'
    CONSTRAINT valid_highlight_source CHECK (source IN ('papers3', 'kobo', 'kindle')),
  ADD COLUMN source_uid text; -- origin's stable per-highlight ID (Kobo BookmarkID); NULL for native rows

-- 2. Imported rows have no word indices, so relax the NOT NULLs.
--    (styles, paragraph_breaks, chapter_title are already nullable.)
ALTER TABLE highlights
  ALTER COLUMN chapter_index DROP NOT NULL,
  ALTER COLUMN start_word    DROP NOT NULL,
  ALTER COLUMN end_word      DROP NOT NULL;

-- 3. Keep native rows honest: word fields are required iff source = 'papers3'.
--    NULLs pass a CHECK, so the existing valid_word_range
--    (end_word >= start_word) needs no change for imported rows.
ALTER TABLE highlights
  ADD CONSTRAINT papers3_requires_word_index CHECK (
    source <> 'papers3'
    OR (chapter_index IS NOT NULL AND start_word IS NOT NULL AND end_word IS NOT NULL)
  );

-- 4. The device natural key now governs NATIVE rows only. Drop the old table
--    constraint and re-create it as a PARTIAL unique index scoped to papers3.
--    Constraint name confirmed via \d highlights against local DB.
ALTER TABLE highlights
  DROP CONSTRAINT highlights_book_id_chapter_index_start_word_end_word_key;
CREATE UNIQUE INDEX highlights_device_natural_key
  ON highlights (book_id, chapter_index, start_word, end_word)
  WHERE source = 'papers3';

-- 5. Import dedup key: stable origin ID, scoped to book + source. The Kobo
--    analog of the device natural key — the idempotency anchor for re-import.
CREATE UNIQUE INDEX highlights_source_uid_key
  ON highlights (book_id, source, source_uid)
  WHERE source_uid IS NOT NULL;

-- 6. Cheap support for ISBN-first book matching in the importer (Issue #497).
CREATE INDEX idx_books_user_isbn
  ON books (user_id, isbn)
  WHERE isbn IS NOT NULL;
