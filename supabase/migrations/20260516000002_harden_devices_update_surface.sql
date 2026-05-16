-- Harden the devices UPDATE write surface: narrow column-level grants,
-- enforce revocation as one-way, and document the policy/grant/trigger
-- dependency.
--
-- Forward-only hot-fix on top of 20260516000001 (PR #179, commit be09c3a).
-- See issue #180 for full severity analysis and attack walkthrough.
--
-- Problem summary:
--
-- 20260516000001 added the "Users can update own devices" RLS policy
-- (USING + WITH CHECK on user_id = auth.uid()) but did NOT narrow the
-- column-level grants. Supabase's bootstrap default grants UPDATE on
-- every column of every public table to anon + authenticated. RLS
-- USING + WITH CHECK only verify the row's user_id is unchanged; they
-- do not constrain which columns a payload writes, nor what value a
-- writable column may take.
--
-- Concretely, against PATCH /rest/v1/devices?id=eq.<own>:
--   - {"api_token_hash":"<sha256-of-chosen-token>"} mints a device
--     token bypassing the rate-limited pairing flow.
--   - {"revoked_at":null} un-revokes a previously revoked device,
--     defeating the user-facing revocation primitive.
--   - {"hardware_id":"<spoof>"} forges the device identifier.
--
-- This migration closes all three vectors with three layered controls:
--
--   (1) Column-scoped GRANT — narrows the application-writable column
--       set to (name, revoked_at). Blocks api_token_hash, hardware_id,
--       paired_at, and the other sensitive columns at the PostgREST
--       grant-check layer, before RLS runs.
--
--   (2) One-way trigger on revoked_at — blocks the NULL transition
--       that the legitimate revoke action's grant on revoked_at cannot
--       prevent. Database-layer invariant; fires for all roles
--       including service_role.
--
--   (3) COMMENT ON POLICY — visible via \d+ devices; documents that
--       the policy, grant, and trigger are all required and must move
--       together.
--
-- Service_role is unaffected — sync, pairing, and transfer flows that
-- write last_synced_at / paired_at / api_token_hash via the admin
-- client retain full UPDATE.
--
-- Verifying after deploy:
--   SELECT grantee, privilege_type, column_name
--   FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='devices'
--     AND privilege_type='UPDATE'
--   ORDER BY grantee, column_name;
--   -- Expected: authenticated → name + revoked_at only;
--   --           anon → none; service_role → all columns.

-- --------------------------------------------------------------------
-- (1) Column-scoped GRANT
-- --------------------------------------------------------------------

REVOKE UPDATE ON public.devices FROM anon, authenticated;
GRANT UPDATE (name, revoked_at) ON public.devices TO authenticated;

-- --------------------------------------------------------------------
-- (2) One-way ratchet trigger on revoked_at
-- --------------------------------------------------------------------
--
-- The legitimate /app/devices revoke action sets revoked_at to NOW(),
-- so the column must remain in the GRANT above. The trigger ensures
-- the ONLY transition allowed is NULL → NOT NULL: once a device is
-- revoked, it cannot be un-revoked at the data layer. This is
-- consistent with current product behavior — there is no documented
-- un-revoke flow in the codebase.
--
-- If a deliberate admin-undo is ever needed:
--   - Add an RPC with SECURITY DEFINER that wraps the operation in
--     ALTER TABLE public.devices DISABLE TRIGGER devices_prevent_unrevoke;
--     ... <controlled update> ...
--     ALTER TABLE public.devices ENABLE TRIGGER devices_prevent_unrevoke;
--     inside a transaction. Document the RPC's audit requirements.
--   - Or have the trigger consult a session GUC like
--     current_setting('app.allow_unrevoke', true) and have the RPC set
--     it via SET LOCAL.
--   - DO NOT bypass by running as the postgres superuser.

CREATE OR REPLACE FUNCTION public.devices_prevent_unrevoke()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'devices.revoked_at is one-way; un-revocation not allowed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER devices_prevent_unrevoke
  BEFORE UPDATE OF revoked_at ON public.devices
  FOR EACH ROW
  EXECUTE FUNCTION public.devices_prevent_unrevoke();

COMMENT ON TRIGGER devices_prevent_unrevoke ON public.devices IS
  'Revocation is one-way at the data layer. Fires for all roles including service_role. To support a deliberate admin-undo, add an RPC with SECURITY DEFINER that toggles ALTER TABLE ... DISABLE/ENABLE TRIGGER within a transaction. Do not bypass by running as postgres.';

-- --------------------------------------------------------------------
-- (3) Self-documenting policy comment
-- --------------------------------------------------------------------

COMMENT ON POLICY "Users can update own devices" ON public.devices IS
  'RLS gates row ownership only. Column scope (name, revoked_at) is enforced by the GRANT in 20260516000002; irrevocability of revoked_at is enforced by trigger devices_prevent_unrevoke. All three are required — do not relax the GRANT or drop the trigger without re-evaluating the column write surface.';
