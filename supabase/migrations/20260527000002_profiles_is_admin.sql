-- 20260527000002_profiles_is_admin.sql
--
-- Adds is_admin boolean to profiles. Gates /app/admin/* surfaces and
-- catalog_admin_actions RLS. Default FALSE; only granted via explicit
-- service-role UPDATE WHERE id = <specific uuid>. No migration ever sets
-- is_admin = true broadly.

ALTER TABLE profiles ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.is_admin IS
  'Gates /app/admin/* surfaces and catalog_admin_actions RLS. '
  'Granted only via explicit service-role UPDATE WHERE id = <specific uuid>. '
  'Never auto-granted; no migration ever sets is_admin = true broadly.';
