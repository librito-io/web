import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";

// Public JWKS endpoint. Supabase Auth (third-party JWT issuer config) fetches
// this URL to verify ES256 tokens minted by /api/realtime-token. Must remain
// unauthenticated and publicly cacheable. Lives at the root (not under /app)
// so it bypasses the session auth guard in /app/+layout.server.ts.
//
// Dynamic env (vs static) lets self-hosters deploy without configuring the
// Realtime keypair; the endpoint returns 503 until LIBRITO_JWT_PUBLIC_KEY_JWK
// is set, instead of failing the build.
export const GET: RequestHandler = () => {
  const raw = env.LIBRITO_JWT_PUBLIC_KEY_JWK;
  if (!raw) {
    return new Response(
      JSON.stringify({
        error: "realtime_disabled",
        message:
          "JWKS not configured on this deployment (LIBRITO_JWT_PUBLIC_KEY_JWK unset)",
      }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  }
  let jwk: unknown;
  try {
    jwk = JSON.parse(raw);
  } catch {
    return new Response(
      JSON.stringify({ error: "server_error", message: "JWKS misconfigured" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new Response(JSON.stringify({ keys: [jwk] }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600, must-revalidate",
    },
  });
};
