-- ============================================================
-- INDEXES
-- ============================================================
-- The sync hot path queries filter by (user_id, updated_at) to
-- find changes since last sync. Other indexes support FK lookups
-- and listing queries.

CREATE INDEX idx_highlights_sync   ON highlights (user_id, updated_at);
CREATE INDEX idx_highlights_book   ON highlights (book_id, chapter_index);
CREATE INDEX idx_notes_sync        ON notes (user_id, updated_at);
-- Note: idx_notes_highlight omitted — UNIQUE(highlight_id) already creates an implicit index
CREATE INDEX idx_books_user        ON books (user_id);
CREATE INDEX idx_devices_user      ON devices (user_id);
CREATE INDEX idx_transfers_device  ON book_transfers (device_id, status);
CREATE INDEX idx_pairing_expires   ON pairing_codes (expires_at);
CREATE INDEX idx_pairing_hardware  ON pairing_codes (hardware_id) WHERE claimed = false;

-- ============================================================
-- updated_at AUTO-UPDATE TRIGGER FUNCTION
-- ============================================================
-- Fires BEFORE UPDATE on tables with an updated_at column.
-- Sets updated_at = now() on every row change. This is what
-- makes sync work: WHERE updated_at > :lastSyncedAt picks up
-- any change including soft-deletes (setting deleted_at also
-- triggers updated_at update) and note edits.

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Apply to all tables with updated_at columns
CREATE TRIGGER set_highlights_updated_at
  BEFORE UPDATE ON highlights
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER set_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER set_books_updated_at
  BEFORE UPDATE ON books
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
