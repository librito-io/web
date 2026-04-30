-- ============================================================
-- rollback_claim_pairing
-- ============================================================
-- Companion to claim_pairing_atomic (20260430000001). Invoked when the
-- application-layer Redis write fails after a successful claim+device
-- transaction. Resets the claim flag so the user can retry pairing.
--
-- This is a FORWARD migration that creates a helper function. The file
-- name uses `_create_rollback_..._fn.sql` rather than `_rollback_...sql`
-- to avoid the down-migration connotation that would mislead operators
-- during incident response.
--
-- DELIBERATE ASYMMETRY: this function does NOT delete the device row.
-- If the device row was inserted fresh by the failing claim, deletion
-- would be correct; if it was a re-pair UPDATE (existing device whose
-- token hash was rotated), deletion would orphan the user. Without
-- tracking which case occurred, the safer rollback leaves the device
-- row intact. Worst case: the user has a device with an api_token_hash
-- that the device never received (because Redis write failed). Re-pair
-- on the next attempt rotates the hash again and writes Redis
-- successfully — full recovery.
--
-- Service-role only.
--
-- The REVOKE+GRANT block is wrapped in a DO block so the four
-- access-control statements appear as one statement to the Supabase CLI
-- v2.90 prepared-statement parser. Without the wrapper, multi-statement
-- access-control files trigger Postgres SQLSTATE 42601 ("cannot insert
-- multiple commands into a prepared statement"). See the footer of
-- 20260430000002_grant_claim_pairing_atomic.sql for the full context.

CREATE OR REPLACE FUNCTION public.rollback_claim_pairing(
  p_pairing_id uuid,
  p_user_id    uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_pairing_id::text));

  UPDATE pairing_codes
     SET claimed = false,
         user_id = NULL
   WHERE id = p_pairing_id
     AND user_id = p_user_id;
END;
$$;

-- See migration 02 footer for the REVOKE-then-GRANT rationale and the
-- DO-block parser workaround.
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.rollback_claim_pairing(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.rollback_claim_pairing(uuid, uuid) FROM anon;
  REVOKE ALL ON FUNCTION public.rollback_claim_pairing(uuid, uuid) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.rollback_claim_pairing(uuid, uuid) TO service_role;
END;
$$;

COMMENT ON FUNCTION public.rollback_claim_pairing IS
  'Rolls back claim_pairing_atomic on application-layer (Redis) failure. '
  'Resets pairing_codes.claimed=false but does NOT delete the device row '
  '(see body for rationale on the asymmetry). Service-role only. See '
  'docs/audits/2026-04-29-server-helpers.md issue B-atomic.';
