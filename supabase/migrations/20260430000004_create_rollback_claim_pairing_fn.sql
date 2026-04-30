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
-- HISTORICAL NOTE — DO BLOCK WORKAROUND, NOW REMOVED:
-- The REVOKE+GRANT block was previously wrapped in a DO block to dodge a
-- Supabase CLI v2.90 parser bug (the splitter mishandled the "atomic"
-- substring in function identifiers — see supabase/cli#5064, fixed in
-- v2.91.1). CI is now pinned >= v2.95.4, so the wrapper is gone. Full
-- context in the header of 20260430000002_grant_claim_pairing_atomic.sql.

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

-- See migration 02 header for the REVOKE-then-GRANT rationale.
REVOKE ALL ON FUNCTION public.rollback_claim_pairing(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rollback_claim_pairing(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.rollback_claim_pairing(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_claim_pairing(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.rollback_claim_pairing IS
  'Rolls back claim_pairing_atomic on application-layer (Redis) failure. '
  'Resets pairing_codes.claimed=false but does NOT delete the device row '
  '(see body for rationale on the asymmetry). Service-role only. See '
  'docs/audits/2026-04-29-server-helpers.md issue B-atomic.';
