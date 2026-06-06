-- ============================================================
-- devices.type + devices.model — device-level identity
-- ============================================================
-- The devices table had no platform discriminator: every paired
-- device defaulted to name='Librito' until the user renamed it, so
-- a Kobo and a PaperS3 were indistinguishable in /app/devices and
-- there was no structured way to badge / default-name / run
-- device-level analytics by platform. Per-highlight provenance
-- (highlights.source) already answers "where did this row come
-- from"; this is the orthogonal "what kind of device is this row"
-- question. See web issue #505.
--
-- Two columns, deliberately distinct:
--   type  — closed discriminator, CHECK-constrained to the same set
--           as highlights.source ('papers3','kobo','kindle').
--           Drives UI badge / default name / analytics.
--   model — free-text descriptive string (e.g. 'Kobo Libra Colour').
--           NULLable, NO CHECK: Kobo ships new models constantly and
--           a CHECK would force a migration per model. Debugging /
--           telemetry only. Reader firmware (reader#57) and the Kobo
--           agent populate it; absent → NULL.
--
-- Threading: device type/model are device-supplied at request time
-- and consumed at claim time, exactly like hardware_id. They ride on
-- the pairing_codes row (written by requestPairingCode), and
-- claim_pairing_atomic reads them out of that row via its existing
-- RETURNING ... INTO — no RPC signature change, no claim-caller
-- param threading, single source of truth on the row. This mirrors
-- how hardware_id already flows.
--
-- Unknown `type` values are coerced to 'papers3' in the TS layer
-- (src/lib/server/pairing.ts), so the CHECK below only ever sees a
-- valid literal; the CHECK is the defense-in-depth backstop, not the
-- primary validator.

-- ------------------------------------------------------------
-- 1. pairing_codes: carry type/model from request to claim.
-- ------------------------------------------------------------
ALTER TABLE public.pairing_codes
  ADD COLUMN device_type  text NOT NULL DEFAULT 'papers3',
  ADD COLUMN device_model text;

COMMENT ON COLUMN public.pairing_codes.device_type IS
  'Device platform discriminator carried from the pairing request to '
  'claim time, read by claim_pairing_atomic into devices.type. '
  'Defaults to ''papers3'' for back-compat with PaperS3 firmware that '
  'sends no deviceType. Coerced to a valid literal in the TS layer.';
COMMENT ON COLUMN public.pairing_codes.device_model IS
  'Free-text device model string (e.g. ''Kobo Libra Colour'') carried '
  'from the pairing request to claim time, read into devices.model. '
  'NULL when the device sends no model. Debugging/telemetry only.';

-- ------------------------------------------------------------
-- 2. devices: type discriminator + free-text model.
-- ------------------------------------------------------------
ALTER TABLE public.devices
  ADD COLUMN type  text NOT NULL DEFAULT 'papers3'
    CONSTRAINT valid_device_type CHECK (type IN ('papers3', 'kobo', 'kindle')),
  ADD COLUMN model text;

-- Stale comment predates the multi-source pivot — devices are no
-- longer ESP32-only (Kobo joins via the on-device sync agent).
COMMENT ON TABLE public.devices IS
  'Paired e-reader devices (PaperS3 / Kobo / future). One row per '
  'physical device per user.';
COMMENT ON COLUMN public.devices.type IS
  'Device platform discriminator: papers3 | kobo | kindle. CHECK '
  'mirrors highlights.source''s valid_highlight_source set. Defaults '
  'to ''papers3''. Set at claim time from pairing_codes.device_type.';
COMMENT ON COLUMN public.devices.model IS
  'Free-text device model string (e.g. ''Kobo Libra Colour''). '
  'NULLable, no CHECK so new models need no migration. Debugging only. '
  'Set at claim time from pairing_codes.device_model.';

-- ------------------------------------------------------------
-- 3. claim_pairing_atomic: write type/model into the device row.
-- ------------------------------------------------------------
-- Signature is UNCHANGED (5-arg). type/model are read from the
-- pairing_codes row inside the existing UPDATE ... RETURNING ... INTO,
-- not passed as params — see header. We recreate the full function
-- body (CREATE OR REPLACE) because plpgsql has no in-place edit; this
-- is a verbatim copy of 20260520000001 with two additions marked
-- `-- #505:` below.

CREATE OR REPLACE FUNCTION public.claim_pairing_atomic(
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
  v_device_type text;   -- #505: read from pairing_codes, written into devices.type
  v_device_model text;  -- #505: read from pairing_codes, written into devices.model
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
  -- #505: also capture device_type/device_model off the row.
  UPDATE pairing_codes
     SET claim_attempts = claim_attempts + 1
   WHERE id = p_pairing_id
   RETURNING claim_attempts, hardware_id, claimed, expires_at,
             device_type, device_model
        INTO v_attempts, v_hardware_id, v_was_claimed, v_expires_at,
             v_device_type, v_device_model;

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
      -- #505: type/model written on INSERT and refreshed on re-pair
      -- (a device that changed model/type re-reports current state),
      -- but `name` is NOT touched — user-chosen name survives re-pair.
      INSERT INTO devices (user_id, hardware_id, api_token_hash, type, model)
      VALUES (p_user_id, v_hardware_id, p_token_hash, v_device_type, v_device_model)
      ON CONFLICT (user_id, hardware_id) DO UPDATE
        SET api_token_hash = EXCLUDED.api_token_hash,
            revoked_at     = NULL,
            paired_at      = now(),
            type           = EXCLUDED.type,
            model          = EXCLUDED.model
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

-- Signature unchanged → existing grants from 20260520000001 still
-- apply. Re-asserting the REVOKE/GRANT is harmless and keeps the
-- function's privilege posture self-documenting at its latest
-- definition site (repo convention for CREATE OR REPLACE).
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) TO service_role;
