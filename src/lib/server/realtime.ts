import { SignJWT } from "jose";

export const REALTIME_TOKEN_TTL_SECONDS = 86400;

// HS256 requires a key at least as long as the hash output (256 bits / 32 B)
// to avoid weakening the signature. Catch a short SUPABASE_JWT_SECRET (env
// typo, dev-mode placeholder) at first mint instead of silently producing
// weak JWTs. See RFC 7518 §3.2.
const MIN_JWT_SECRET_BYTES = 32;

/**
 * Mint a Supabase JWT for the device to authenticate Phoenix Channels
 * subscriptions. The token is strictly weaker than the device Bearer it
 * was minted from: read-only, RLS-narrowed to one user, no mutation
 * surface. Bearer revocation propagates to /api/sync immediately;
 * outstanding Realtime JWTs remain valid until `exp` (≤24 h). See
 * spec §3 + §13 risk #4 for the trade-off.
 *
 * Secret is injected (not read from `$env/static/private`) so vitest can
 * exercise this function without mocking $env. The route handler at
 * /api/realtime-token wires SUPABASE_JWT_SECRET in.
 */
export async function mintRealtimeToken(opts: {
  userId: string;
  deviceId: string;
  jwtSecret: string;
}): Promise<{ token: string; expiresIn: number }> {
  const secretBytes = new TextEncoder().encode(opts.jwtSecret);
  if (secretBytes.length < MIN_JWT_SECRET_BYTES) {
    throw new Error(
      `SUPABASE_JWT_SECRET is too short for HS256 (${secretBytes.length} B, need ≥ ${MIN_JWT_SECRET_BYTES} B)`,
    );
  }
  const secret = secretBytes;
  const nowSec = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    role: "authenticated",
    device_id: opts.deviceId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(opts.userId)
    .setAudience("authenticated")
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + REALTIME_TOKEN_TTL_SECONDS)
    .sign(secret);

  return { token, expiresIn: REALTIME_TOKEN_TTL_SECONDS };
}
