// Builds the OAuth redirectTo URL passed to signInWithOAuth. The return_to is
// threaded as an (encoded) query param so it survives the provider round-trip;
// it is re-validated server-side in /auth/callback via resolveReturnTo. The
// production Supabase redirect allow-list MUST use a wildcard callback entry
// (e.g. https://librito.io/auth/callback*) — an exact entry rejects the query
// variant (verified, gotrue v2.189.0). See the spec §1.
export function buildOAuthRedirectTo(origin: string, returnTo: string): string {
  return `${origin}/auth/callback?return_to=${encodeURIComponent(returnTo)}`;
}
