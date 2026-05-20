-- ============================================================
-- pairing_codes.claim_attempts — per-code global attempt cap
-- ============================================================
-- Closes the IP-rotation bypass on the 6-digit pairing code
-- (issue #260). The route-level pairClaimLimiter is keyed on
-- ${code}:${ip} (5/5min/IP), which any caller with rotating
-- proxies can fan out around. A per-code global counter,
-- atomic with the claim transaction, removes IP as the
-- bypass primitive without touching code keyspace (UX bar
-- is the 6-digit phone-typing length).
--
-- Counter is reset implicitly via the 5-min code TTL: each
-- requestPairingCode INSERT mints a fresh row with
-- claim_attempts=0, so the cap is per-code, not per-user or
-- per-hardware.
--
-- Cap value is passed as `p_max_attempts` from the caller
-- (src/lib/server/pairing.ts MAX_CLAIM_ATTEMPTS_PER_CODE) to
-- keep a single source of truth in TypeScript; the SQL just
-- enforces whatever the caller asks for. Service-role-only
-- GRANT means attacker-controlled inputs cannot reach this
-- parameter — only our own server code does.
--
-- Cap semantics: increment first, then refuse when
-- claim_attempts > p_max_attempts. With cap=10, the 11th
-- entry sees post-increment value 11 → refused. First 10
-- entries are admitted to the existing claim logic.
--
-- RPC signature change (4-arg -> 5-arg). Postgres treats
-- overloaded signatures as distinct objects; DROP IF EXISTS
-- the old shape so any caller pinned to the 4-arg form fails
-- loudly at deploy time rather than silently bypassing the
-- cap.
--
-- Return shape gains one column: `expired boolean NOT NULL`.
-- Existing won=true/false rows set expired=false. Cap-exceeded
-- emits a single row with expired=true and NULL device fields,
-- which the caller maps to ClaimResult { error: "code_expired" }.
-- Adding a column to the RETURNS TABLE is additive — existing
-- field accesses on device_id/device_name/won keep working.

ALTER TABLE public.pairing_codes
  ADD COLUMN claim_attempts integer NOT NULL DEFAULT 0
  CHECK (claim_attempts >= 0);

COMMENT ON COLUMN public.pairing_codes.claim_attempts IS
  'Per-code global claim-attempt counter, incremented inside '
  'claim_pairing_atomic on every entry regardless of source IP. '
  'Caps brute-force fan-out against the 1M-keyspace 6-digit code '
  'when an attacker rotates IPs around the route-level per-IP '
  'rate limit. Reset implicitly via 5-min code TTL — each new '
  'requestPairingCode mints a row with claim_attempts=0. '
  'See issue #260.';

-- Drop the 4-arg signature. Plain CREATE FUNCTION below will
-- fail loudly if a re-run finds a stale 5-arg version, which is
-- the right signal during incident response.
DROP FUNCTION IF EXISTS public.claim_pairing_atomic(uuid, uuid, text, text);

CREATE FUNCTION public.claim_pairing_atomic(
  p_user_id      uuid,
  p_pairing_id   uuid,
  p_token_hash   text,
  p_user_email   text,
  p_max_attempts integer
) RETURNS TABLE(
  device_id   uuid,
  device_name text,
  won         boolean,
  expired     boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_hardware_id text;
  v_winner_user uuid;
  v_attempts    integer;
  v_was_claimed boolean;
  v_expires_at  timestamptz;
BEGIN
  -- Serialize concurrent callers for this pairing_id. Same
  -- semantics as 20260430000001; see that file for full
  -- rationale on the advisory lock and the loser/replay branch.
  PERFORM pg_advisory_xact_lock(hashtext(p_pairing_id::text));

  -- Step 1: increment attempt counter, capture row state.
  -- Done unconditionally so every entry pays the counter cost,
  -- even attempts that would otherwise no-op (already-claimed,
  -- expired, etc). Without this an attacker could probe codes
  -- against rows in any state without burning the budget.
  UPDATE pairing_codes
     SET claim_attempts = claim_attempts + 1
   WHERE id = p_pairing_id
   RETURNING claim_attempts, hardware_id, claimed, expires_at
        INTO v_attempts, v_hardware_id, v_was_claimed, v_expires_at;

  IF NOT FOUND THEN
    -- pairing_id missing entirely. JS layer normally short-
    -- circuits before reaching here (lookup returns null); this
    -- branch is defense-in-depth. Emit no rows; caller maps to
    -- invalid_code/already_claimed depending on context.
    RETURN;
  END IF;

  IF v_attempts > p_max_attempts THEN
    -- Cap exceeded. Refuse regardless of expiry, claim state, or
    -- caller identity. Emit a single sentinel row with expired=true
    -- so the caller can distinguish "cap hit" from "no rows"
    -- (which means already-claimed-by-other-user / missing row).
    RETURN QUERY SELECT NULL::uuid, NULL::text, FALSE, TRUE;
    RETURN;
  END IF;

  -- Step 2: try to win the claim transition. Conditional UPDATE
  -- with the same expires_at + claimed=false predicate as the
  -- prior version — defense-in-depth against a caller that
  -- skipped the JS lookup's expiry check.
  IF NOT v_was_claimed AND v_expires_at > now() THEN
    UPDATE pairing_codes
       SET claimed    = true,
           user_id    = p_user_id,
           user_email = p_user_email
     WHERE id = p_pairing_id
       AND claimed = false
       AND expires_at > now();

    IF FOUND THEN
      -- We won. Insert OR update the device row in the same
      -- transaction. ON CONFLICT (user_id, hardware_id) handles
      -- re-pair by rotating the token hash and clearing
      -- revoked_at. The token-co-rotation invariant from
      -- 20260516000003 is satisfied: SET api_token_hash and
      -- revoked_at=NULL travel together.
      INSERT INTO devices (user_id, hardware_id, api_token_hash)
      VALUES (p_user_id, v_hardware_id, p_token_hash)
      ON CONFLICT (user_id, hardware_id) DO UPDATE
        SET api_token_hash = EXCLUDED.api_token_hash,
            revoked_at     = NULL,
            paired_at      = now()
      RETURNING devices.id, devices.name
        INTO device_id, device_name;
      won := true;
      expired := false;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- Replay / loser branch. Read current owner; if same user, the
  -- advisory lock guarantees the winner has committed and the
  -- device row exists by UNIQUE(user_id, hardware_id). Different
  -- user (or missing row) falls through with no rows added.
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
      expired := false;
      RETURN NEXT;
    END IF;
  END IF;
END;
$$;

-- Repo-standard REVOKE-then-GRANT for SECURITY INVOKER RPCs.
-- See header of 20260430000002 for full rationale; CLI is
-- pinned >= 2.95.4 so no DO-block wrapper is needed.
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) TO service_role;

COMMENT ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) IS
  'Atomic pairing-claim flow with per-code global attempt cap. '
  'Increments claim_attempts on every entry; refuses with '
  'expired=true when cap (p_max_attempts) is exceeded. Service-'
  'role only; called from src/lib/server/pairing.ts. See issue '
  '#260 and 20260520000001 for design rationale.';
