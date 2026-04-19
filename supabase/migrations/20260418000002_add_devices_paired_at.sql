-- Add paired_at to devices so re-pairing updates the "Paired on" timestamp
-- shown in the web UI. created_at stays immutable (row's first creation
-- time), paired_at tracks the latest successful pair/re-pair.
--
-- Backfill existing rows with created_at so the UI reads sensibly until the
-- device re-pairs.

ALTER TABLE devices
  ADD COLUMN paired_at timestamptz NOT NULL DEFAULT now();

UPDATE devices SET paired_at = created_at WHERE paired_at IS NULL;
