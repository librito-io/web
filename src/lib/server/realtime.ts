import { SignJWT, importPKCS8 } from "jose";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";

export const REALTIME_TOKEN_TTL_SECONDS = 86400;

/**
 * Returns the Phoenix Channels WebSocket URL and Supabase anon key the
 * device needs to open a Realtime connection. Both values are public, so
 * we serve them from the token endpoint instead of compiling them into
 * firmware — that lets self-hosters point devices at their own Supabase
 * project without a firmware rebuild.
 */
export function getRealtimeConnectionInfo(): {
  realtimeUrl: string;
  anonKey: string;
} {
  const realtimeUrl =
    PUBLIC_SUPABASE_URL.replace(/^https:\/\//, "wss://").replace(
      /^http:\/\//,
      "ws://",
    ) + "/realtime/v1/websocket";
  return { realtimeUrl, anonKey: PUBLIC_SUPABASE_ANON_KEY };
}

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";

/**
 * Mint an ES256 JWT for the device to authenticate Phoenix Channels
 * subscriptions. We are a third-party JWT issuer registered with Supabase
 * (Auth → Third-party Auth, JWKS at /.well-known/jwks.json). Realtime's
 * verifier picks our public key by `kid` and validates ES256.
 *
 * Token is strictly weaker than the device Bearer it was minted from:
 * read-only, RLS-narrowed to one user, no mutation surface. Bearer
 * revocation propagates to /api/sync immediately; outstanding Realtime
 * JWTs remain valid until `exp` (≤24 h). See spec §3 + §13 risk #4.
 *
 * Key material is injected (not read from `$env/static/private`) so
 * vitest can exercise this function without mocking $env.
 */
export async function mintRealtimeToken(opts: {
  userId: string;
  deviceId: string;
  privateKeyPem: string;
  kid: string;
  issuer: string;
}): Promise<{ token: string; expiresIn: number }> {
  if (!opts.privateKeyPem.includes(PEM_HEADER)) {
    throw new Error(
      "LIBRITO_JWT_PRIVATE_KEY_PEM is not a PKCS8 PEM (missing BEGIN PRIVATE KEY header)",
    );
  }
  const key = await importPKCS8(opts.privateKeyPem, "ES256");
  const nowSec = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    role: "authenticated",
    device_id: opts.deviceId,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: opts.kid })
    .setIssuer(opts.issuer)
    .setSubject(opts.userId)
    .setAudience("authenticated")
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + REALTIME_TOKEN_TTL_SECONDS)
    .sign(key);

  return { token, expiresIn: REALTIME_TOKEN_TTL_SECONDS };
}
