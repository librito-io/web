-- ============================================================
-- BOOKS (per-user, one row per bookHash per user)
-- ============================================================
-- Book metadata synced from device. book_hash is FNV-1a 32-bit
-- hash of the EPUB file, matching the device's existing cache
-- key scheme (src/core/FnvHash.h).

CREATE TABLE books (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  book_hash      text        NOT NULL
                             CONSTRAINT valid_book_hash CHECK (book_hash ~ '^[0-9a-f]{8}$'),
  title          text,
  author         text,
  language       text,
  isbn           text,
  published_date text,
  cover_path     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE(user_id, book_hash),
  UNIQUE(id, user_id)  -- exists to anchor composite FK from highlights(book_id, user_id)
);

COMMENT ON TABLE books IS 'Book metadata, one row per book per user';
COMMENT ON COLUMN books.book_hash IS 'FNV-1a 32-bit hash of EPUB file (hex string, e.g. "da4c5f2e")';
COMMENT ON COLUMN books.cover_path IS 'Path in Supabase Storage cover-cache bucket (nullable until fetched)';

-- ============================================================
-- HIGHLIGHTS (device-created)
-- ============================================================
-- Created on the ESP32 device during reading. Natural key is
-- (book_id, chapter_index, start_word, end_word) — uniquely
-- identifies a text selection within a book. Used for upsert
-- during sync (same selection = same highlight, update text).
--
-- Composite FK (book_id, user_id) → books(id, user_id) ensures
-- highlights can only reference the owning user's books.

CREATE TABLE highlights (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id              uuid        NOT NULL,
  user_id              uuid        NOT NULL,
  chapter_index        smallint    NOT NULL,
  start_word           integer     NOT NULL,
  end_word             integer     NOT NULL,
  text                 text        NOT NULL,
  chapter_title        text,
  styles               text,
  paragraph_breaks     jsonb,
  device_timestamp_raw bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  CONSTRAINT valid_word_range CHECK (end_word > start_word),
  UNIQUE(book_id, chapter_index, start_word, end_word),
  UNIQUE(id, user_id),  -- exists to anchor composite FK from notes(highlight_id, user_id)
  FOREIGN KEY (book_id, user_id) REFERENCES books(id, user_id) ON DELETE CASCADE
);

COMMENT ON TABLE highlights IS 'Highlights created on e-reader device';
COMMENT ON COLUMN highlights.chapter_index IS 'Zero-based chapter index within the EPUB';
COMMENT ON COLUMN highlights.start_word IS 'Word index of highlight start within chapter';
COMMENT ON COLUMN highlights.end_word IS 'Word index of highlight end within chapter';
COMMENT ON COLUMN highlights.styles IS 'Encoded style run info (e.g. "R45B12I5" — Regular 45 words, Bold 12, Italic 5)';
COMMENT ON COLUMN highlights.paragraph_breaks IS 'JSON array of word indices where paragraph breaks occur within highlight';
COMMENT ON COLUMN highlights.device_timestamp_raw IS 'Raw uint32 timestamp from device — archived as-is, not used for queries';
COMMENT ON COLUMN highlights.deleted_at IS 'Soft-delete: non-null = trashed (30-day retention before permanent delete)';

-- ============================================================
-- NOTES (web-created, one per highlight)
-- ============================================================
-- Notes are created and edited exclusively in the web app, then
-- synced down to the device. One note per highlight enforced by
-- UNIQUE(highlight_id). Composite FK ensures notes can only
-- reference the owning user's highlights.

CREATE TABLE notes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id uuid        NOT NULL,
  user_id      uuid        NOT NULL,
  text         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE(highlight_id),
  FOREIGN KEY (highlight_id, user_id) REFERENCES highlights(id, user_id) ON DELETE CASCADE
);

COMMENT ON TABLE notes IS 'User notes attached to highlights, created/edited via web app';
