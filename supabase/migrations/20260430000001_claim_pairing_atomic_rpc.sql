-- ============================================================
-- claim_pairing_atomic
-- ============================================================
-- Atomic pairing-claim flow: collapses the conditional UPDATE on
-- pairing_codes and the INSERT/UPDATE on devices into a single Postgres
-- transaction with row-level serialization via pg_advisory_xact_lock.
--
-- See docs/audits/2026-04-29-server-helpers.md issue B-atomic for the
-- full design rationale, including:
--   - the race class this eliminates (concurrent same-user same-code
--     claims observing the post-claim, pre-device-insert window)
--   - the rejected alternative (application-layer retry-with-backoff)
--   - the supersession history (B2/B3/B4 originally fixed by application
--     ordering in PR #39, B5 surfaced during pre-merge smoke, all
--     subsumed here)
--
-- Caller: src/lib/server/pairing.ts:claimPairingCode. Service-role only.
-- The device API path uses the admin client. No RLS bypass concerns.
-- Redis token write happens APPLICATION-SIDE after this RPC returns
-- won=true. On Redis failure, caller invokes rollback_claim_pairing
-- (defined in 20260430000004_create_rollback_claim_pairing_fn.sql).

CREATE OR REPLACE FUNCTION public.claim_pairing_atomic(
  p_user_id    uuid,
  p_pairing_id uuid,
  p_token_hash text
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
  -- Serialize concurrent callers for this pairing_id. Transaction-scoped
  -- advisory lock; released automatically on COMMIT/ROLLBACK. Losers
  -- block here until the winner finishes the entire claim+device
  -- transaction, then proceed and observe the committed state.
  PERFORM pg_advisory_xact_lock(hashtext(p_pairing_id::text));

  -- Try to win the claim transition. The conditional WHERE makes this
  -- idempotent under concurrent retries: only one caller can transition
  -- claimed=false to true. The expires_at predicate is defence-in-depth:
  -- the JS layer (src/lib/server/pairing.ts) already filters expired codes
  -- before invoking this RPC, but enforcing expiry server-side closes any
  -- gap from a misconfigured caller or future code path that bypasses the
  -- JS filter. Captures hardware_id for the device upsert.
  UPDATE pairing_codes
     SET claimed = true,
         user_id = p_user_id
   WHERE id = p_pairing_id
     AND claimed = false
     AND expires_at > now()
   RETURNING hardware_id INTO v_hardware_id;

  v_won := FOUND;

  IF v_won THEN
    -- We won. Insert OR update the device row in the same transaction.
    -- ON CONFLICT (user_id, hardware_id) handles re-pair (existing
    -- device for this user/hardware combination) by rotating the token
    -- hash and clearing revoked_at. The backing UNIQUE constraint is
    -- devices_user_id_hardware_id_key (auto-named by Postgres from the
    -- UNIQUE(user_id, hardware_id) clause on the devices table). Source
    -- of truth is `\d devices` in psql, not a specific migration file.
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
    -- Race lost OR claim already held. Read the current owner.
    SELECT pc.user_id, pc.hardware_id
      INTO v_winner_user, v_hardware_id
      FROM pairing_codes pc
     WHERE pc.id = p_pairing_id;

    -- If a different user holds the claim (or the pairing code is
    -- missing), fall through with no rows added. Caller maps empty
    -- result to already_claimed/invalid_code.
    IF v_winner_user IS NOT NULL AND v_winner_user = p_user_id THEN
      -- Same user holds the claim. The advisory lock ensured the
      -- winner has committed by the time we got here, so the device
      -- row is guaranteed to exist by UNIQUE (user_id, hardware_id).
      -- This is the idempotent-replay path (caller already paired,
      -- browser retry / Safari keep-alive drop).
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

-- GRANT and COMMENT live in 20260430000002_grant_claim_pairing_atomic.sql.
-- Splitting them out works around a Supabase CLI v2.90 parser quirk where
-- this specific function body's plpgsql shape causes the CLI to send the
-- whole file as a single Parse message, triggering Postgres SQLSTATE 42601
-- ("cannot insert multiple commands into a prepared statement"). Direct
-- psql ingestion of the same content works fine. Splitting per-statement
-- files is the cleanest workaround until we upgrade the CLI.
