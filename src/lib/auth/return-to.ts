// Validates a ?return_to= query param value supplied to /auth/login by
// the appAuthGuard hook (hooks.server.ts) when redirecting an
// unauthenticated GET. After sign-in the login page calls
// `goto(resolveReturnTo(raw))`. This must NEVER be skipped — without
// validation, an attacker can craft links of the form
// /auth/login?return_to=//evil.com or
// /auth/login?return_to=https://attacker.com that turn a successful
// login into an open-redirect oracle (CWE-601). Defense at the
// consumer is mandatory even if the hook only writes safe values,
// because the query param is attacker-controllable end-to-end.
//
// Allow-list semantics (NOT a denylist):
//   - must be a string
//   - must start with `/app/` (the only routes the hook gates)
//   - must NOT start with `//` (protocol-relative — bypasses scheme check)
//   - must NOT contain `\` (some browsers normalize \ → / in URLs)
//   - decodes percent-encoding once (the hook encodeURIComponent's it)
// Anything that fails any check → fall back to `/app`. The fallback is
// deliberately silent: a forged param is indistinguishable from a stale
// bookmark to a deleted route, so logging or alerting would be noisy.
export function resolveReturnTo(raw: string | null | undefined): string {
  const FALLBACK = "/app";
  if (typeof raw !== "string" || raw.length === 0) return FALLBACK;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return FALLBACK;
  }

  // Reject protocol-relative + backslash-smuggling before the prefix
  // check, because `//evil.com` and `\\evil.com` would technically
  // satisfy a naive startsWith("/app/") if combined as
  // `/app//../\\evil.com` and a sloppy normalizer.
  if (decoded.startsWith("//")) return FALLBACK;
  if (decoded.includes("\\")) return FALLBACK;
  if (!decoded.startsWith("/app/") && decoded !== "/app") return FALLBACK;

  return decoded;
}
