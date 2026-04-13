-- ============================================================
-- BOOK TRANSFERS (upload queue)
-- ============================================================
-- Temporary queue for EPUBs uploaded via web app, pending
-- download by the device. Files are deleted from Supabase
-- Storage after the device confirms receipt. Transfers pending
-- longer than 7 days are auto-expired by pg_cron.

CREATE TABLE book_transfers (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id     uuid        REFERENCES devices(id) ON DELETE SET NULL,
  filename      text        NOT NULL,
  file_size     bigint      NOT NULL,
  storage_path  text        NOT NULL,
  sha256        text        NOT NULL
                           CONSTRAINT valid_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status        text        NOT NULL DEFAULT 'pending',
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  downloaded_at timestamptz,

  CONSTRAINT valid_transfer_status
    CHECK (status IN ('pending', 'downloaded', 'expired'))
);

COMMENT ON TABLE book_transfers IS 'Queue for EPUB transfers from web to device — storage is temporary';
COMMENT ON COLUMN book_transfers.device_id IS 'Target device (null = any device owned by user picks it up)';
COMMENT ON COLUMN book_transfers.sha256 IS 'SHA-256 hash computed at upload time, verified by device after download';
COMMENT ON COLUMN book_transfers.storage_path IS 'Path in Supabase Storage book-transfers bucket';

-- ============================================================
-- COVER CACHE (shared cover library, deduplicated by ISBN)
-- ============================================================
-- Book covers fetched from Open Library / Google Books on first
-- encounter, then stored permanently in Supabase Storage as a
-- shared cover library. All users with the same ISBN share one
-- cover image. Rows are never deleted — the library grows
-- monotonically (one row per unique ISBN).

CREATE TABLE cover_cache (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  isbn         text        NOT NULL UNIQUE,
  storage_path text        NOT NULL,
  source_url   text,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE cover_cache IS 'Shared cover library — one cover per ISBN, fetched once, served to all users';
COMMENT ON COLUMN cover_cache.fetched_at IS 'When this cover was fetched from the external API';
