-- Index on api_token_hash for O(1) device lookup during token authentication.
-- Not partial (no WHERE clause) so the auth middleware can distinguish
-- "invalid token" from "token belongs to a revoked device" in a single query.
CREATE INDEX idx_devices_token ON devices (api_token_hash);

-- Update comment to reflect SHA-256 choice
COMMENT ON COLUMN devices.api_token_hash IS 'SHA-256 hex digest of the device API token (sk_device_xxx). Indexed for fast lookup during authentication.';
