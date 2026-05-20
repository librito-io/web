import { randomInt, randomBytes, createHash } from "crypto";

export function generatePairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function generateDeviceToken(): string {
  return `sk_device_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Per-pairing challenge secret minted at /api/pair/request and required
// by /api/pair/status. 32 bytes of randomness → ~256 bits of entropy,
// matching device-token strength. base64url is URL-safe and Authorization-
// header-safe (no padding, no '+' / '/'). See issue #286 step 2.
export function generatePollSecret(): string {
  return randomBytes(32).toString("base64url");
}

// SHA-256 hex of the plaintext pollSecret. Same shape and column-type
// invariant as devices.api_token_hash and the CHECK in
// pairing_codes.poll_secret_hash (lowercase 64-hex).
export function hashPollSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
