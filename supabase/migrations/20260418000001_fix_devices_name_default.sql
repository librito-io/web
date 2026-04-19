-- Reconcile drifted DB default on devices.name.
-- The original migration (20260412000002) declared DEFAULT 'Librito', but the
-- live DB was running with DEFAULT 'Pocket Reader' (source of drift unknown —
-- likely a manual dashboard edit). This migration realigns the default and
-- backfills any existing rows that inherited the wrong value.

ALTER TABLE devices ALTER COLUMN name SET DEFAULT 'Librito';

UPDATE devices SET name = 'Librito' WHERE name = 'Pocket Reader';
