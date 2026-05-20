-- ============================================================
-- pairing_codes.poll_secret_hash — per-pairing challenge secret
-- ============================================================
-- Closes the unauthenticated-token-fetch surface on
-- /api/pair/status/<pairingId> (issue #286 step 2). The route is
-- unauth by necessity — the device polls it before it has any
-- token — and on a successful claim returns the plaintext device
-- token to any caller that knows the pairingId UUID within the
-- ~5-min Redis TTL. A leaked pairingId (log, breadcrumb, network
-- capture, pre-pair device snapshot) is enough to grab a
-- permanent device token off-device.
--
-- pollSecret is a 32-byte cryptographically random value minted
-- alongside the pairing row in /api/pair/request and returned
-- once to the device. Server stores the SHA-256 hex hash. On
-- every /api/pair/status poll the device presents the plaintext
-- (Authorization: Bearer <pollSecret> primary, ?pollSecret=
-- query-param fallback) and the server compares hashes. A leaked
-- pairingId alone is no longer sufficient — the attacker also
-- needs the pollSecret, which is delivered once and never logged
-- or echoed.
--
-- NULLable column: rows minted before this migration deploy stay
-- live for up to PAIRING_CODE_TTL_SEC (300s). The status handler
-- treats poll_secret_hash IS NULL as "pre-migration row, no
-- challenge enforced" and logs a one-off event for the rollout
-- window. The follow-up tightening (refuse if missing, regardless
-- of column NULL) happens once firmware rolls out — tracked in a
-- separate issue.
--
-- Hash form mirrors devices.api_token_hash: lowercase SHA-256 hex
-- (length 64). CHECK enforces shape so a future caller cannot
-- accidentally insert raw plaintext or a wrong-format value.

ALTER TABLE public.pairing_codes
  ADD COLUMN poll_secret_hash text NULL
  CHECK (poll_secret_hash IS NULL OR poll_secret_hash ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.pairing_codes.poll_secret_hash IS
  'SHA-256 hex (lowercase, 64 chars) of the per-pairing pollSecret '
  'minted by /api/pair/request and returned once to the device. '
  'Required by /api/pair/status to authenticate the polling caller. '
  'NULL only for rows minted before the column existed — those rows '
  'expire within PAIRING_CODE_TTL_SEC (300s). See issue #286.';
