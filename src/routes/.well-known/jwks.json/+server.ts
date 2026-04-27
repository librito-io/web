import type { RequestHandler } from "./$types";
import { LIBRITO_JWT_PUBLIC_KEY_JWK } from "$env/static/private";

// Public JWKS endpoint. Supabase Auth (third-party JWT issuer config) fetches
// this URL to verify ES256 tokens minted by /api/realtime-token. Must remain
// unauthenticated and publicly cacheable. Lives at the root (not under /app)
// so it bypasses the session auth guard in /app/+layout.server.ts.
export const GET: RequestHandler = () => {
  let jwk: unknown;
  try {
    jwk = JSON.parse(LIBRITO_JWT_PUBLIC_KEY_JWK);
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
