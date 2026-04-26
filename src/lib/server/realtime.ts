import { SignJWT } from "jose";

export const REALTIME_TOKEN_TTL_SECONDS = 86400;

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
  const secret = new TextEncoder().encode(opts.jwtSecret);
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
