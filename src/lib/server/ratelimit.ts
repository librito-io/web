import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} from "$env/static/private";

// `@upstash/redis` defaults to 3 retries with exponential backoff (~4.3 s
// total hold) before surfacing the error. Every request-path Redis call —
// rate limit checks, pairing-token storage, pairing-token lookup —
// inherits that budget. Under an Upstash outage, every in-flight request
// would block on the retry budget for 4+ s before failing or falling open,
// saturating Vercel function instances and turning a partial-Redis outage
// into a Librito-wide 504 storm.
//
// Fail fast instead. Pairing-write fails closed via the existing
// rollback_claim_pairing path (PR #40); pairing-read returns code_expired
// and the device retries on the next 3 s poll; ratelimit consumers wrap
// `.limit()` in `safeLimit` below so a Redis fail surfaces as fail-open
// (allow the request) rather than 5xx. See audit issue P6.
export const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
  retry: { retries: 0 },
});

/**
 * Wrap a `Ratelimit.limit()` call so an Upstash outage fails open (allow
 * the request) instead of surfacing 5xx.
 *
 * Rationale: rate limits are an availability guard, not a security
 * boundary. The downstream business logic still enforces the actual
 * security invariants (auth, RLS, token hash lookup, claim atomicity).
 * The cost of allowing a request during a partial-Upstash outage is one
 * unmetered request per route hit; the cost of NOT allowing it is a
 * 504-storm cascade that brings down endpoints with no actual rate-check
 * work to do.
 *
 * Logs `ratelimit.upstash_unreachable` with the supplied `label` so an
 * operator can correlate the throw across rate-limiter prefixes.
 */
export async function safeLimit(
  limiter: Ratelimit,
  key: string,
  label: string,
): Promise<{ success: boolean; reset: number }> {
  try {
    return await limiter.limit(key);
  } catch (err) {
    console.error("ratelimit.upstash_unreachable", {
      limiter: label,
      key,
      error: String(err),
    });
    return { success: true, reset: 0 };
  }
}

// /api/pair/request — 3 requests per minute per IP
export const pairRequestLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1m"),
  prefix: "rl:pair:request",
});

// /api/pair/status/[pairingId] — 1 request per 3 seconds per IP
export const pairStatusLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "3s"),
  prefix: "rl:pair:status",
});

// /api/pair/claim — 5 attempts per 5 minutes per code:IP
export const pairClaimLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "5m"),
  prefix: "rl:pair:claim",
});

// /api/sync — 1 request per 30 seconds per device
export const syncLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "30s"),
  prefix: "rl:sync",
});

// Transfer: upload initiation (browser, per user)
export const transferUploadLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:upload",
});

// Transfer: download URL (device, per device)
export const transferDownloadLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "10s"),
  prefix: "rl:transfer:download",
});

// Transfer: confirm (device, per device:transfer). Caps the /confirm-loop
// abuse window — a stolen device token cannot drive attempt_count from 0
// to MAX_TRANSFER_ATTEMPTS in tight succession on a single transfer.
export const transferConfirmLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:confirm",
});

// Transfer: retry (browser, per user). Mirrors initiate's posture so a
// failed-row reset cannot be looped from the UI or a script.
export const transferRetryLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:retry",
});

// /api/realtime-token — two limiters layered for defense in depth.
// Per-device: 1 mint / 60 s. Bounds firmware-bug reconnect storms.
// Per-user: 30 mints / 1 h. Bounds re-pair-loop bypass (a logged-in user
// re-pairs to mint a new device.id and skip the per-device cap). 30/h
// covers a fleet of ~25 devices on one account with reconnect headroom.
export const realtimeTokenLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "60s"),
  prefix: "rl:realtime:token",
});

export const realtimeTokenUserLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "1h"),
  prefix: "rl:realtime:token:user",
});
