-- 20260527000002_profiles_is_admin.sql
--
-- Adds is_admin boolean to profiles and hardens the write surface so
-- authenticated users cannot self-promote.
--
-- Without this hardening, Supabase's bootstrap GRANT ALL on every
-- public table column to anon + authenticated leaves is_admin writable
-- from the client. The existing "Users can update own profile" RLS
-- policy from 20260412000006 verifies row identity (auth.uid() = id),
-- NOT column subset — so PATCH /rest/v1/profiles?id=eq.<self> with
-- body {"is_admin": true} would mint admin on any signed-up account.
-- Same attack class closed for devices in 20260516000002.
--
-- Three layered controls:
--
--   (1) Column-scoped GRANT — REVOKE UPDATE wholesale, GRANT UPDATE
--       (display_name) back to authenticated. id + is_admin + created_at
--       drop off the writable column set at the PostgREST grant-check
--       layer, before RLS runs. service_role retains full UPDATE via
--       the table-level GRANT (not affected by the column-level
--       narrowing).
--
--   (2) BEFORE UPDATE trigger on is_admin transitions — blocks
--       OLD.is_admin IS DISTINCT FROM NEW.is_admin unless the caller
--       is service_role. Defence-in-depth against a future migration
--       that accidentally widens the column GRANT, and against
--       superuser/postgres connections (the trigger fires for all
--       roles, but excepts service_role so the legitimate
--       admin-promotion path via the admin client still works).
--
--   (3) COMMENT ON COLUMN — visible via \d+ profiles; documents that
--       the column grant + trigger move together.

ALTER TABLE profiles ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------------
-- (1) Column-scoped UPDATE grant
-- --------------------------------------------------------------------

REVOKE UPDATE ON public.profiles FROM anon, authenticated;
GRANT UPDATE (display_name) ON public.profiles TO authenticated;

-- --------------------------------------------------------------------
-- (2) Trigger blocking is_admin transitions from non-service_role
-- --------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.profiles_prevent_is_admin_self_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.is_admin IS DISTINCT FROM NEW.is_admin
     AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'profiles.is_admin can only be set by service_role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Lock down the trigger function's EXECUTE grants. PostgreSQL exempts
-- trigger fire from EXECUTE checks, so REVOKE from anon/authenticated
-- doesn't break the trigger — but blocks the function from being
-- called as an RPC by those roles (per CLAUDE.md function-grants
-- pattern, matching update_updated_at + devices_prevent_unrevoke).
REVOKE EXECUTE ON FUNCTION public.profiles_prevent_is_admin_self_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.profiles_prevent_is_admin_self_update() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.profiles_prevent_is_admin_self_update() TO service_role;

CREATE TRIGGER profiles_prevent_is_admin_self_update
  BEFORE UPDATE OF is_admin ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_prevent_is_admin_self_update();

COMMENT ON TRIGGER profiles_prevent_is_admin_self_update ON public.profiles IS
  'Backstops the column-level REVOKE of is_admin from authenticated. Fires for every UPDATE OF is_admin and raises insufficient_privilege unless the caller is service_role. Both layers move together — do not relax one without re-evaluating the other.';

-- --------------------------------------------------------------------
-- (3) Self-documenting column comment
-- --------------------------------------------------------------------

COMMENT ON COLUMN profiles.is_admin IS
  'Gates /app/admin/* surfaces and catalog_admin_actions RLS. Write surface narrowed to service_role only via (a) column-level REVOKE in this migration and (b) trigger profiles_prevent_is_admin_self_update. Granted only via explicit service-role UPDATE WHERE id = <specific uuid>. Never auto-granted; no migration ever sets is_admin = true broadly.';
