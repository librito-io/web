import { SignJWT, importJWK } from "jose";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";

export const REALTIME_TOKEN_TTL_SECONDS = 86400;

export type RealtimeSigningJwk = {
  kty: "EC";
  kid: string;
  alg: "ES256";
  crv: "P-256";
  d: string;
  x: string;
  y: string;
  use?: string;
  key_ops?: readonly string[];
  ext?: boolean;
};

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

// Module-scope cache: once we've confirmed our kid is in the project's
// JWKS, don't refetch on every mint. Caching only the success branch lets
// us recover automatically after a rotation propagates.
let jwksKidConfirmed: string | null = null;

// kid-keyed; rotation propagates by missing the cache and re-importing.
const importedKeys = new Map<string, CryptoKey>();

async function checkKidInJwks(kid: string, supabaseUrl: string): Promise<void> {
  if (jwksKidConfirmed === kid) return;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) {
      // Distinct from `realtime.jwks_fetch_threw` (catch branch) and
      // `realtime.kid_not_in_jwks` (fetch ok but kid absent) so dashboards
      // can split "upstream JWKS endpoint sad" from "key is rotated out".
      console.warn("realtime.jwks_fetch_non_ok", { status: res.status, kid });
      return;
    }
    const body = (await res.json()) as { keys?: Array<{ kid: string }> };
    const keys = body.keys ?? [];
    if (keys.some((k) => k.kid === kid)) {
      jwksKidConfirmed = kid;
    } else {
      console.warn("realtime.kid_not_in_jwks", {
        kid,
        knownKids: keys.map((k) => k.kid),
      });
    }
  } catch (err) {
    console.warn("realtime.jwks_fetch_threw", { error: String(err), kid });
  }
}

/**
 * Mint an ES256 JWT for the device to authenticate Phoenix Channels
 * subscriptions. Signed with our Supabase-imported standby signing key —
 * Supabase publishes the public side at <project>.supabase.co/auth/v1/.well-known/jwks.json,
 * Realtime fetches that JWKS and verifies our token's kid against it.
 *
 * Token is strictly weaker than the device Bearer it was minted from:
 * read-only, RLS-narrowed to one user, no mutation surface. Bearer
 * revocation propagates to /api/sync immediately; outstanding Realtime
 * JWTs remain valid until `exp` (≤24 h). See spec §3 + §13 risk #4.
 *
 * Key material is injected (not read from `$env/dynamic/private`) so
 * vitest can exercise this function without mocking $env.
 *
 * Realtime ignores `iss` (probed Stage 1 V2). We still set it to the
 * Supabase auth-v1 URL for forward compatibility — costs nothing.
 */
export async function mintRealtimeToken(opts: {
  userId: string;
  deviceId: string;
  privateJwk: RealtimeSigningJwk;
  supabaseUrl: string;
}): Promise<{ token: string; expiresIn: number }> {
  if (!opts.privateJwk.d) {
    throw new Error(
      "LIBRITO_JWT_PRIVATE_KEY_JWK is missing the `d` private component",
    );
  }

  let key = importedKeys.get(opts.privateJwk.kid);
  if (!key) {
    // Strip key_ops so importJWK doesn't reject a verify-only standby JWK.
    // The on-disk dev key has key_ops=["verify"] (gotrue's standby contract),
    // but jose insists on a sign-capable key for a private import.
    const { key_ops, ...jwkForImport } = opts.privateJwk;
    key = (await importJWK(jwkForImport, "ES256")) as CryptoKey;
    importedKeys.set(opts.privateJwk.kid, key);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const issuer = `${opts.supabaseUrl}/auth/v1`;

  const token = await new SignJWT({
    role: "authenticated",
    device_id: opts.deviceId,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: opts.privateJwk.kid })
    .setIssuer(issuer)
    .setSubject(opts.userId)
    .setAudience("authenticated")
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + REALTIME_TOKEN_TTL_SECONDS)
    .sign(key);

  // Fire-and-forget JWKS sanity check. Warns if our kid isn't published —
  // catches misconfig (wrong key in env) or rotation propagation lag.
  // Doesn't block the mint.
  void checkKidInJwks(opts.privateJwk.kid, opts.supabaseUrl);

  return { token, expiresIn: REALTIME_TOKEN_TTL_SECONDS };
}
