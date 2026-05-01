// Module is `$env`-free so vitest can import it directly without
// `vi.mock("$env/static/private", ...)` ceremony. Production
// `ratelimit.ts` and test code share this single source of truth for
// the fail-closed Retry-After value — drift in either direction would
// keep tests green while production wire format changes.

/**
 * Seconds the client should wait before retrying after a fail-closed
 * 503 from `enforceRateLimit` / `enforceRateLimits`. Surfaced in the
 * `Retry-After` response header. Tuned for an Upstash partial-outage
 * recovery window (anecdotally < 30s).
 */
export const FAIL_CLOSED_RETRY_AFTER_SEC = 30;
