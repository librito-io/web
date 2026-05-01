import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} from "$env/static/private";
import { jsonError } from "$lib/server/errors";

// `@upstash/redis` defaults to 3 retries with exponential backoff (~4.3 s
// total hold) before surfacing the error. Every request-path Redis call —
// rate limit checks, pairing-token storage, pairing-token lookup —
// inherits that budget. Under an Upstash outage, every in-flight request
// would block on the retry budget for 4+ s before failing or falling open,
// saturating Vercel function instances and turning a partial-Redis outage
// into a Librito-wide 504 storm.
//
// Fail fast instead. Pairing-write fails closed via the existing
// rollback_claim_pairing path (PR #40); pairing-read catches the throw
// and returns code_expired so the device retries on the next 3 s poll
// (`checkPairingStatus` and `claimPairingCode` replay-path in
// pairing.ts); ratelimit consumers wrap `.limit()` in `safeLimit` below
// so a Redis fail surfaces as fail-open (allow the request) rather than
// 5xx. See audit issue P6.
const UPSTASH_RETRY_BUDGET = 0;

export const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
  retry: { retries: UPSTASH_RETRY_BUDGET },
});

// ----------------------------------------------------------------------
// Per-limiter fail-mode policy (PR #48).
//
// Each limiter declares its posture at construction. Routes use
// `enforceRateLimit` / `enforceRateLimits` to map the limiter's outcome
// to an HTTP response without re-deciding the policy at the callsite.
//
// failMode: "open"   — Upstash outage allows the request. Use for
//                      availability-class limits where downstream auth/
//                      RLS still gate access (sync, transfer, pair
//                      request/status).
// failMode: "closed" — Upstash outage returns 503. Use for
//                      brute-force gates and credential mint endpoints
//                      (pair:claim, realtime-token).
// ----------------------------------------------------------------------

export type FailMode = "open" | "closed";

export type LimitResult = Awaited<ReturnType<Ratelimit["limit"]>>;

export type RateLimiter = {
  /**
   * Apply the rate limit for the supplied key. Narrows the upstream
   * `Ratelimit.limit(key, opts?)` signature — extras (`req`, `geo`,
   * `userAgent` for analytics) are not threaded through. Future analytics
   * wiring would widen this; trivial refactor when it lands.
   */
  limit: (key: string) => Promise<LimitResult>;
  readonly label: string;
  readonly failMode: FailMode;
};

export function createLimiter(opts: {
  window: ReturnType<typeof Ratelimit.slidingWindow>;
  prefix: string;
  failMode: FailMode;
}): RateLimiter {
  if (!opts.prefix.startsWith("rl:")) {
    throw new Error(
      `createLimiter: prefix must start with "rl:" — received "${opts.prefix}"`,
    );
  }
  const inner = new Ratelimit({
    redis,
    limiter: opts.window,
    prefix: opts.prefix,
  });
  return {
    limit: (key) => inner.limit(key),
    label: opts.prefix.slice(3),
    failMode: opts.failMode,
  };
}

// ----------------------------------------------------------------------
// Internal: single-limiter check with timeout + fail-mode handling.
// Public callers should use enforceRateLimit / enforceRateLimits below.
// ----------------------------------------------------------------------

const UPSTASH_TIMEOUT_MS = 1500;
const FAIL_CLOSED_RETRY_AFTER_SEC = 30;

type FailClosedSentinel = { failClosed: true };

function isFailClosed(
  v: LimitResult | FailClosedSentinel,
): v is FailClosedSentinel {
  return "failClosed" in v && v.failClosed === true;
}

function syntheticAllowResult(): LimitResult {
  return {
    success: true,
    limit: 0,
    remaining: 0,
    reset: 0,
    pending: Promise.resolve(),
  } as LimitResult;
}

function isProgrammerError(err: unknown): boolean {
  return (
    err instanceof RangeError ||
    err instanceof SyntaxError ||
    err instanceof ReferenceError
  );
}

function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TypeError" && "cause" in err) return true;
  return /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|abort|network/i.test(
    err.message,
  );
}

async function safeLimit(
  limiter: RateLimiter,
  key: string,
): Promise<LimitResult | FailClosedSentinel> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // signal not yet consumed by Upstash SDK — placeholder for when it supports AbortSignal
      ctrl.abort();
      reject(
        Object.assign(new Error("ratelimit_timeout"), { __timeout: true }),
      );
    }, UPSTASH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([limiter.limit(key), timeoutPromise]);
  } catch (err) {
    if (isProgrammerError(err)) throw err;
    const isTimeout =
      typeof err === "object" && err !== null && "__timeout" in err;
    const errorName = err instanceof Error ? err.name : typeof err;
    const error = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (isTimeout) {
      console.error("ratelimit.upstash_timeout", {
        limiter: limiter.label,
        failMode: limiter.failMode,
        timeoutMs: UPSTASH_TIMEOUT_MS,
      });
    } else if (isTransportError(err)) {
      console.error("ratelimit.upstash_unreachable", {
        limiter: limiter.label,
        failMode: limiter.failMode,
        error,
        stack,
      });
    } else {
      console.error("ratelimit.unexpected_throw", {
        limiter: limiter.label,
        failMode: limiter.failMode,
        errorName,
        error,
        stack,
      });
    }
    return limiter.failMode === "closed"
      ? { failClosed: true }
      : syntheticAllowResult();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Single-limiter route helper. Returns a 429 Response on denial, a 503
 * Response on Upstash failure for fail-closed limiters, or null when the
 * route should proceed.
 */
export async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  message: string,
): Promise<Response | null> {
  const result = await safeLimit(limiter, key);
  if (isFailClosed(result)) {
    return jsonError(
      503,
      "rate_limit_unavailable",
      "Service temporarily unavailable. Please retry shortly.",
      FAIL_CLOSED_RETRY_AFTER_SEC,
    );
  }
  if (result.success) return null;
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return jsonError(429, "rate_limited", message, retryAfter);
}

/**
 * Multi-limiter route helper. Runs all checks via Promise.all (no
 * short-circuit — all checks are gated on the same Upstash availability,
 * so latency is dominated by the slowest call regardless). Precedence:
 * any failClosed → 503; else any deny → 429 with max(reset); else null.
 */
export async function enforceRateLimits(
  checks: Array<{ limiter: RateLimiter; key: string }>,
  message: string,
): Promise<Response | null> {
  if (checks.length === 0) {
    throw new Error("enforceRateLimits: checks must be a non-empty array");
  }
  const results = await Promise.all(
    checks.map((c) => safeLimit(c.limiter, c.key)),
  );
  if (results.some(isFailClosed)) {
    return jsonError(
      503,
      "rate_limit_unavailable",
      "Service temporarily unavailable. Please retry shortly.",
      FAIL_CLOSED_RETRY_AFTER_SEC,
    );
  }
  const denied = (results as LimitResult[]).filter((r) => !r.success);
  if (denied.length > 0) {
    const reset = Math.max(...denied.map((r) => r.reset));
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(429, "rate_limited", message, retryAfter);
  }
  return null;
}

// /api/pair/request — 3 requests per minute per IP
export const pairRequestLimiter = createLimiter({
  window: Ratelimit.slidingWindow(3, "1m"),
  prefix: "rl:pair:request",
  failMode: "open",
});

// /api/pair/status/[pairingId] — 1 request per 3 seconds per IP
export const pairStatusLimiter = createLimiter({
  window: Ratelimit.slidingWindow(1, "3s"),
  prefix: "rl:pair:status",
  failMode: "open",
});

// /api/pair/claim — 5 attempts per 5 minutes per code:IP
export const pairClaimLimiter = createLimiter({
  window: Ratelimit.slidingWindow(5, "5m"),
  prefix: "rl:pair:claim",
  failMode: "closed",
});

// /api/sync — 1 request per 30 seconds per device
export const syncLimiter = createLimiter({
  window: Ratelimit.slidingWindow(1, "30s"),
  prefix: "rl:sync:device",
  failMode: "open",
});

// Transfer: upload initiation (browser, per user)
export const transferUploadLimiter = createLimiter({
  window: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:upload",
  failMode: "open",
});

// Transfer: download URL (device, per device)
export const transferDownloadLimiter = createLimiter({
  window: Ratelimit.slidingWindow(1, "10s"),
  prefix: "rl:transfer:download",
  failMode: "open",
});

// Transfer: confirm (device, per device:transfer). Caps the /confirm-loop
// abuse window — a stolen device token cannot drive attempt_count from 0
// to MAX_TRANSFER_ATTEMPTS in tight succession on a single transfer.
export const transferConfirmLimiter = createLimiter({
  window: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:confirm",
  failMode: "open",
});

// Transfer: retry (browser, per user). Mirrors initiate's posture so a
// failed-row reset cannot be looped from the UI or a script.
export const transferRetryLimiter = createLimiter({
  window: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:retry",
  failMode: "open",
});

// /api/realtime-token — two limiters layered for defense in depth.
// Per-device: 1 mint / 60 s. Bounds firmware-bug reconnect storms.
// Per-user: 30 mints / 1 h. Bounds re-pair-loop bypass (a logged-in user
// re-pairs to mint a new device.id and skip the per-device cap). 30/h
// covers a fleet of ~25 devices on one account with reconnect headroom.
//
// Both fail closed: a single Upstash blip must not collapse the
// defense-in-depth invariant under a signed-credential mint endpoint.
export const realtimeTokenLimiter = createLimiter({
  window: Ratelimit.slidingWindow(1, "60s"),
  prefix: "rl:realtime:token",
  failMode: "closed",
});

export const realtimeTokenUserLimiter = createLimiter({
  window: Ratelimit.slidingWindow(30, "1h"),
  prefix: "rl:realtime:token:user",
  failMode: "closed",
});
