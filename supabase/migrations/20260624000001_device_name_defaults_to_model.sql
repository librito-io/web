-- Device default name = model string (issue #506).
-- ------------------------------------------------------------
-- devices.name defaulted to 'Librito' (20260412000002 / 20260418000001) and was
-- only ever written by the user rename action — claim_pairing_atomic never set
-- it, so every freshly paired device showed as "Librito" until renamed. 'Librito'
-- is the web app's name, not the device. The device's own model string
-- (e.g. 'Kobo Libra Colour', captured into devices.model by #505) is the correct
-- default. This migration:
--   0. adds a private _device_type_label() helper (NULL/empty-model fallback),
--   1. seeds devices.name from the model on the claim INSERT path,
--   2. drops the 'Librito' column default,
--   3. backfills existing name='Librito' rows.
-- name stays user-editable; a rename survives re-pair (ON CONFLICT never touches
-- name, unchanged from #505).

-- 0. Type-label fallback. Single source of truth for the RPC + the backfill.
--    model is nullable; in practice always non-empty going forward (kobo-sync
--    degrades to 'Kobo', firmware always sends 'PaperS3'), so this is a safety
--    net for legacy rows / future sources sending no model.
CREATE OR REPLACE FUNCTION public._device_type_label(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_type
    WHEN 'kobo'    THEN 'Kobo'
    WHEN 'papers3' THEN 'PaperS3'
    WHEN 'kindle'  THEN 'Kindle'
    ELSE 'Device'
  END
$$;

REVOKE EXECUTE ON FUNCTION public._device_type_label(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._device_type_label(text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._device_type_label(text) TO service_role;

-- 1. claim_pairing_atomic: seed name from model on INSERT (verbatim re-create of
--    20260606000001 with the single `-- #506:` change on the INSERT path).
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
  v_device_type text;
  v_device_model text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_pairing_id::text));

  UPDATE pairing_codes
     SET claim_attempts = claim_attempts + 1
   WHERE id = p_pairing_id
   RETURNING claim_attempts, hardware_id, claimed, expires_at,
             device_type, device_model
        INTO v_attempts, v_hardware_id, v_was_claimed, v_expires_at,
             v_device_type, v_device_model;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_attempts > p_max_attempts THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, FALSE, TRUE;
    RETURN;
  END IF;

  IF NOT v_was_claimed AND v_expires_at > now() THEN
    UPDATE pairing_codes
       SET claimed    = true,
           user_id    = p_user_id,
           user_email = p_user_email
     WHERE id = p_pairing_id
       AND claimed = false
       AND expires_at > now();

    IF FOUND THEN
      -- #506: seed name from the reported model on INSERT; fall back to the
      -- type label when the model is NULL/empty. NOT touched on re-pair
      -- (ON CONFLICT set-list omits name) so a user rename survives.
      INSERT INTO devices (user_id, hardware_id, api_token_hash, type, model, name)
      VALUES (
        p_user_id, v_hardware_id, p_token_hash, v_device_type, v_device_model,
        COALESCE(NULLIF(trim(v_device_model), ''), _device_type_label(v_device_type))
      )
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

-- Signature unchanged → existing grants still apply; re-assert per the
-- CREATE OR REPLACE convention.
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text, text, integer) TO service_role;

-- 2. Drop the 'Librito' column default. claim_pairing_atomic is the only INSERT
--    path into devices and now always supplies name explicitly. Keep NOT NULL.
ALTER TABLE devices ALTER COLUMN name DROP DEFAULT;

-- 3. Backfill existing default-named rows to their model. 'Librito' is never a
--    legitimate device name, so rewriting every such row is correct, not lossy.
--    Renamed rows (e.g. a PaperS3 already named 'Paper S3') are skipped.
UPDATE devices
   SET name = COALESCE(NULLIF(trim(model), ''), _device_type_label(type))
 WHERE name = 'Librito';
