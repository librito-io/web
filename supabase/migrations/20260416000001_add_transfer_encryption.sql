-- Add encryption columns to book_transfers
ALTER TABLE book_transfers
  ADD COLUMN encrypted boolean NOT NULL DEFAULT false,
  ADD COLUMN iv text;

-- Expand status constraint to include pending_upload
ALTER TABLE book_transfers
  DROP CONSTRAINT valid_transfer_status,
  ADD CONSTRAINT valid_transfer_status
    CHECK (status IN ('pending_upload', 'pending', 'downloaded', 'expired'));

-- Relax SHA-256 constraint: allow empty string for pending_upload rows
-- (SHA-256 is computed in complete-upload, not at initiate time)
ALTER TABLE book_transfers
  DROP CONSTRAINT valid_sha256,
  ADD CONSTRAINT valid_sha256
    CHECK (sha256 ~ '^[0-9a-f]{64}$' OR (status = 'pending_upload' AND sha256 = ''));

-- Add transfer_secret to pairing_codes (temporary, cleared after exchange)
ALTER TABLE pairing_codes
  ADD COLUMN transfer_secret text;

-- Update pg_cron: add 1-hour cleanup for abandoned uploads
-- The existing job runs daily. Add a separate job that runs every 10 minutes
-- for abandoned uploads (short TTL needs more frequent checks).
SELECT cron.schedule(
  'expire-abandoned-uploads',
  '*/10 * * * *',
  $$
    UPDATE public.book_transfers
      SET status = 'expired'
      WHERE status = 'pending_upload'
        AND uploaded_at < now() - interval '1 hour';
  $$
);
