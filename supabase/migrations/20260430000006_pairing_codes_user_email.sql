-- ============================================================
-- Denormalize auth.users.email onto pairing_codes
-- ============================================================
-- Removes a gotrue round-trip from src/lib/server/pairing.ts:
-- checkPairingStatus. Devices poll /api/pair/status/* every 3 s
-- (per ratelimit.ts). On the success path the prior shape did:
--   1. SELECT claimed/expires_at/user_id FROM pairing_codes
--   2. auth.admin.getUserById(user_id)  -- gotrue round-trip
-- The denormalisation collapses (2) into (1) by stamping
-- user_email at claim time. Audit issue P4.
--
-- The auth.admin.getUserById call moves from "every poll" to
-- "once per claim" — actually further: the route handler already
-- has the email on `user` from safeGetSession(), so we feed it
-- through directly with no auth-admin lookup at all.
--
-- Migration steps:
--   1. ADD COLUMN user_email text on pairing_codes (NULL until
--      claimed).
--   2. DROP + CREATE claim_pairing_atomic with the new
--      p_user_email param. The function signature changes
--      (3 args -> 4 args); Postgres treats overloaded signatures
--      as distinct objects, so DROP IF EXISTS the old shape first
--      to avoid leaving an orphan version reachable.
--   3. Re-GRANT the new signature to service_role (REVOKE from
--      PUBLIC/anon/authenticated mirrors the repo standard).
--   4. CREATE OR REPLACE rollback_claim_pairing to clear
--      user_email symmetrically with claimed/user_id. Signature
--      unchanged, so existing GRANT in 20260430000004 survives.

ALTER TABLE public.pairing_codes
  ADD COLUMN user_email text;

COMMENT ON COLUMN public.pairing_codes.user_email IS
  'Denormalised auth.users.email at claim time. Stamped by '
  'claim_pairing_atomic (see 20260430000006) so '
  'src/lib/server/pairing.ts:checkPairingStatus can return it '
  'without a gotrue round-trip per poll. NULL until claimed. '
  'Stale only if the user mutates their auth email AFTER claim '
  'but BEFORE the device finishes polling — harmless for the '
  'one-time confirmation UX. Audit issue P4.';

-- Drop the 3-arg signature so it cannot be invoked. The 4-arg
-- version below replaces it; existing call sites in
-- src/lib/server/pairing.ts will be updated in lockstep.
DROP FUNCTION IF EXISTS public.claim_pairing_atomic(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.claim_pairing_atomic(
  p_user_id    uuid,
  p_pairing_id uuid,
  p_token_hash text,
  p_user_email text
) RETURNS TABLE(
  device_id   uuid,
  device_name text,
  won         boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_hardware_id text;
  v_winner_user uuid;
  v_won         boolean;
BEGIN
  -- Serialize concurrent callers for this pairing_id. Same
  -- semantics as 20260430000001; see that file for full
  -- rationale on the advisory lock and the loser/replay branch.
  PERFORM pg_advisory_xact_lock(hashtext(p_pairing_id::text));

  UPDATE pairing_codes
     SET claimed    = true,
         user_id    = p_user_id,
         user_email = p_user_email
   WHERE id = p_pairing_id
     AND claimed = false
     AND expires_at > now()
   RETURNING hardware_id INTO v_hardware_id;

  v_won := FOUND;

  IF v_won THEN
    INSERT INTO devices (user_id, hardware_id, api_token_hash)
    VALUES (p_user_id, v_hardware_id, p_token_hash)
    ON CONFLICT (user_id, hardware_id) DO UPDATE
      SET api_token_hash = EXCLUDED.api_token_hash,
          revoked_at     = NULL,
          paired_at      = now()
    RETURNING devices.id, devices.name
      INTO device_id, device_name;
    won := true;
    RETURN NEXT;
  ELSE
    SELECT pc.user_id, pc.hardware_id
      INTO v_winner_user, v_hardware_id
      FROM pairing_codes pc
     WHERE pc.id = p_pairing_id;

    IF v_winner_user IS NOT NULL AND v_winner_user = p_user_id THEN
      SELECT d.id, d.name
        INTO device_id, device_name
        FROM devices d
       WHERE d.user_id = p_user_id
         AND d.hardware_id = v_hardware_id;

      IF device_id IS NOT NULL THEN
        won := false;
        RETURN NEXT;
      END IF;
    END IF;
  END IF;
END;
$$;

-- Repo-standard REVOKE-then-GRANT for SECURITY INVOKER RPCs.
-- See header of 20260430000002 for the full rationale; CLI is
-- pinned >= 2.95.4 so no DO-block wrapper is needed.
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text) IS
  'Atomic pairing-claim flow with denormalised user_email. See '
  '20260430000001 for the original design rationale and '
  '20260430000006 for the email-denorm motivation (audit P4). '
  'Service-role only; called from src/lib/server/pairing.ts.';

-- Rollback: clear user_email alongside claimed and user_id so
-- the row's denorm fields stay consistent with the claim flag.
-- Signature unchanged, so the GRANT in 20260430000004 carries
-- over.
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
     SET claimed    = false,
         user_id    = NULL,
         user_email = NULL
   WHERE id = p_pairing_id
     AND user_id = p_user_id;
END;
$$;
