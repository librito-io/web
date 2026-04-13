-- ============================================================
-- DEVICES (paired e-readers)
-- ============================================================
-- One row per physical device paired to a user account.
-- hardware_id is a UUID v4 generated on the device's first boot
-- and stored on SD at /librito/.device_id.
-- UNIQUE(user_id, hardware_id) allows re-pairing the same device.

CREATE TABLE devices (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  hardware_id    text        NOT NULL,
  name           text        NOT NULL DEFAULT 'Librito',
  api_token_hash text        NOT NULL,
  last_synced_at timestamptz,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE(user_id, hardware_id)
);

COMMENT ON TABLE devices IS 'Paired ESP32 e-reader devices';
COMMENT ON COLUMN devices.hardware_id IS 'UUID v4 generated on device first boot, stored at /librito/.device_id';
COMMENT ON COLUMN devices.api_token_hash IS 'Hash of the device API token (sk_device_xxx). Use argon2id (preferred) or bcrypt — choose one and stay consistent.';
COMMENT ON COLUMN devices.revoked_at IS 'Non-null = device is unpaired. Device gets 401 on next sync.';

-- ============================================================
-- PAIRING CODES (temporary, TTL: 5 minutes)
-- ============================================================
-- OAuth 2.0 Device Authorization Grant pattern.
-- Device requests a code, displays it on e-ink screen.
-- User enters code in browser to link device to account.
-- Codes are single-use and expire after 5 minutes.

CREATE TABLE pairing_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL,
  hardware_id text        NOT NULL,
  user_id     uuid        REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  claimed     boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pairing_codes IS 'Temporary pairing codes for device auth flow';
COMMENT ON COLUMN pairing_codes.hardware_id IS 'Device UUID — matches poll requests to the correct code row';
COMMENT ON COLUMN pairing_codes.user_id IS 'Set when user claims the code in the browser';

-- Unique among unclaimed codes only. Prevents two active codes
-- with the same value. Expiry is enforced in application code
-- because Postgres rejects volatile functions (now()) in partial
-- index predicates.
--
-- IMPORTANT for API implementers (Phase 2): The poll/claim query
-- MUST check both conditions: WHERE code = $1 AND claimed = false
-- AND expires_at > now(). Checking only claimed = false could match
-- a stale unclaimed code from a prior session.
CREATE UNIQUE INDEX idx_pairing_codes_unclaimed
  ON pairing_codes (code)
  WHERE claimed = false;
