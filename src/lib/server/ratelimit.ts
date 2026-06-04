import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} from "$env/static/private";
import { jsonError } from "$lib/server/errors";
import { FAIL_CLOSED_RETRY_AFTER_SEC } from "$lib/server/ratelimit.constants";
import { logger } from "$lib/server/log";

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
// pairing.ts); ratelimit callers use enforceRateLimit / enforceRateLimits,
// which apply each limiter's declared failMode (open → allow, closed → 503).
// See audit issue P6 and the PR #48 fail-mode policy design doc.
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

/**
 * Outcome of a single `safeLimit` call. Discriminated on `kind` so the
 * fail-open allow path is distinguishable from a genuine quota success.
 *   - `ok`         — upstream returned a `LimitResult`; read `.success`.
 *   - `failOpen`   — upstream errored, limiter policy is fail-open; the
 *                    caller should treat the request as allowed.
 *   - `failClosed` — upstream errored, limiter policy is fail-closed; the
 *                    caller should emit a 503.
 */
export type SafeOutcome =
  | { kind: "ok"; result: LimitResult }
  | { kind: "failOpen"; label: string }
  | { kind: "failClosed"; label: string };

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

/**
 * @internal — exported for unit-test contract assertions only. Production
 * callers should use `enforceRateLimit` / `enforceRateLimits`.
 */
export async function safeLimit(
  limiter: RateLimiter,
  key: string,
): Promise<SafeOutcome> {
  // Upstash REST `.limit()` does not accept an `AbortSignal`; a timed-out
  // call resolves in the background and the result is discarded by
  // `Promise.race`. The orphaned request is bounded by the function
  // lifetime.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error("ratelimit_timeout"), { __timeout: true }),
      );
    }, UPSTASH_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([limiter.limit(key), timeoutPromise]);
    return { kind: "ok", result };
  } catch (err) {
    if (isProgrammerError(err)) throw err;
    const isTimeout =
      typeof err === "object" && err !== null && "__timeout" in err;
    const error = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (isTimeout) {
      logger().error(
        {
          event: "ratelimit.upstash_timeout",
          limiter: limiter.label,
          failMode: limiter.failMode,
          timeoutMs: UPSTASH_TIMEOUT_MS,
        },
        "ratelimit.upstash_timeout",
      );
    } else if (isTransportError(err)) {
      logger().error(
        {
          event: "ratelimit.upstash_unreachable",
          limiter: limiter.label,
          failMode: limiter.failMode,
          error,
          stack,
        },
        "ratelimit.upstash_unreachable",
      );
    } else {
      const errorName = err instanceof Error ? err.name : typeof err;
      logger().error(
        {
          event: "ratelimit.unexpected_throw",
          limiter: limiter.label,
          failMode: limiter.failMode,
          errorName,
          error,
          stack,
        },
        "ratelimit.unexpected_throw",
      );
    }
    return limiter.failMode === "closed"
      ? { kind: "failClosed", label: limiter.label }
      : { kind: "failOpen", label: limiter.label };
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
  const outcome = await safeLimit(limiter, key);
  if (outcome.kind === "failClosed") {
    return jsonError(
      503,
      "rate_limit_unavailable",
      "Service temporarily unavailable. Please retry shortly.",
      FAIL_CLOSED_RETRY_AFTER_SEC,
    );
  }
  if (outcome.kind === "failOpen") return null;
  if (outcome.result.success) return null;
  const retryAfter = Math.max(
    1,
    Math.ceil((outcome.result.reset - Date.now()) / 1000),
  );
  return jsonError(429, "rate_limited", message, retryAfter);
}

/**
 * Multi-limiter route helper. Runs `checks` sequentially in array order
 * and short-circuits on the first deny so the loser's downstream tokens
 * are not consumed (sliding-window decrements happen at call time on the
 * Upstash side — once spent, the bucket is locked until the window rolls
 * over even if the request is later rejected).
 *
 * Precedence within the prefix that did execute:
 *   any failClosed → 503; else any deny → 429 with that limiter's reset;
 *   else null.
 *
 * Latency cost vs. Promise.all is bounded by `UPSTASH_TIMEOUT_MS` per
 * call (~50–100 ms typical). For our only N>1 caller (`/api/realtime-token`,
 * mints once per minute per device) the trade buys two operationally
 * load-bearing properties:
 *   - per-device storms cannot drain the per-user budget (T1 #2);
 *   - asymmetric Redis blips emit `ratelimit.partial_drain` so a
 *     device-locked window is correlatable to the upstream cause (T1 #1).
 *
 * Order callers in priority of binding constraint (per-device 1/60s
 * before per-user 30/h on /api/realtime-token).
 */
export async function enforceRateLimits(
  checks: Array<{ limiter: RateLimiter; key: string }>,
  message: string,
): Promise<Response | null> {
  if (checks.length === 0) {
    throw new Error("enforceRateLimits: checks must be a non-empty array");
  }
  const succeededLabels: string[] = [];
  for (const check of checks) {
    const outcome = await safeLimit(check.limiter, check.key);
    if (outcome.kind === "failClosed") {
      if (succeededLabels.length > 0) {
        // The earlier limiter(s) already consumed their tokens against the
        // upstream; this one failed → 503. Surface the asymmetry so an
        // operator looking at "device locked out of /realtime-token" can
        // correlate to the Upstash blip in the same time window.
        logger().warn(
          {
            event: "ratelimit.partial_drain",
            succeededLabels: [...succeededLabels],
            failedLabel: outcome.label,
          },
          "ratelimit.partial_drain",
        );
      }
      return jsonError(
        503,
        "rate_limit_unavailable",
        "Service temporarily unavailable. Please retry shortly.",
        FAIL_CLOSED_RETRY_AFTER_SEC,
      );
    }
    if (outcome.kind === "failOpen") {
      succeededLabels.push(outcome.label);
      continue;
    }
    if (!outcome.result.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((outcome.result.reset - Date.now()) / 1000),
      );
      return jsonError(429, "rate_limited", message, retryAfter);
    }
    succeededLabels.push(check.limiter.label);
  }
  return null;
}

// /api/pair/request — 3 requests per minute per IP. Fail-closed because
// the endpoint is unauthenticated and writes a row to `pairing_codes`
// per call. The unique index `idx_pairing_codes_unclaimed` covers
// `code` (not `hardware_id`), so multiple unclaimed rows per
// `hardware_id` are allowed and bounded only by the 5-minute TTL.
// Under an Upstash outage the fail-open posture would let an attacker
// rotating UUIDs flood inserts at platform-permitted rate. The outage
// cost of fail-closed is anonymous 503s on a route that already retries
// — acceptable. Mirrors `pairClaimLimiter`'s brute-force-gate posture.
export const pairRequestLimiter = createLimiter({
  window: Ratelimit.slidingWindow(3, "1m"),
  prefix: "rl:pair:request",
  failMode: "closed",
});

// /api/pair/request — second axis: 5 requests per 5 minutes per
// hardwareId. The per-IP limit alone cannot bound a per-hardware flood
// when the attacker rotates IPs; this caps per-device damage at 5
// outstanding codes per 5-minute window, which still permits the
// legitimate retry pattern (lost-power re-pair) inside one TTL. Same
// fail-closed posture as `pairRequestLimiter` — an Upstash blip must
// not collapse the defense-in-depth invariant on a credential-mint
// path. (Issue #285.)
export const pairRequestPerHardwareLimiter = createLimiter({
  window: Ratelimit.slidingWindow(5, "5m"),
  prefix: "rl:pair:request:hw",
  failMode: "closed",
});

// /api/pair/status/[pairingId] — 1 request per 3 seconds per IP
export const pairStatusLimiter = createLimiter({
  window: Ratelimit.slidingWindow(1, "3s"),
  prefix: "rl:pair:status",
  failMode: "open",
});

// /app/api/pair/claim — 5 attempts per 5 minutes per code:IP
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

// Kobo highlight import (device, per device). Slightly looser than sync since
// imports are batchy (agent auto-syncs on WiFi-up). Dedicated prefix so it
// does not contend with PaperS3 sync on a dual-device user. Fail-OPEN matches
// the device-write posture: an Upstash outage must not block ingest.
export const importKoboLimiter = createLimiter({
  window: Ratelimit.slidingWindow(2, "30s"),
  prefix: "rl:import:kobo:device",
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
// Fail-open is safe because /confirm is a guarded UPDATE … WHERE
// status='pending'; replays after Upstash recovery are no-ops. Worst
// case during outage: a device-authed attacker burns their own quota
// for no effect on row state.
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

// Transfer: finalize (browser, per user). One call per upload, fired once
// the browser's PUT to the signed upload URL succeeds. Matches the
// initiate posture (5/min) — a stuck client cannot loop finalize on the
// same transferId because the handler is idempotent on already-verified
// rows and guarded on the pending→verified transition. Fail-open mirrors
// sibling browser transfer limiters.
export const transferFinalizeLimiter = createLimiter({
  window: Ratelimit.slidingWindow(5, "1m"),
  prefix: "rl:transfer:finalize",
  failMode: "open",
});

// Transfer: cancel/DELETE (browser, per user). DELETE is non-idempotent
// (Storage remove + DB row delete) and callable in a loop. Fail-open
// matches sibling browser transfer limiters — downstream ownership
// check still gates row deletion under an Upstash outage.
export const transferCancelLimiter = createLimiter({
  window: Ratelimit.slidingWindow(30, "1m"),
  prefix: "rl:transfer:cancel",
  failMode: "open",
});

// Transfer: list/GET (browser, per user). Natural polling target for the
// transfer UI — cap per-user fan-out so a stuck client cannot drive the
// Supabase row scan in a tight loop. Fail-open mirrors the rest of the
// transfer browser surface.
export const transferListLimiter = createLimiter({
  window: Ratelimit.slidingWindow(60, "1m"),
  prefix: "rl:transfer:list",
  failMode: "open",
});

// /api/realtime-token — two limiters layered for defense in depth.
// Per-device: 1 mint / 60 s. Bounds firmware-bug reconnect storms.
// Per-user: 30 mints / 1 h. Bounds re-pair-loop bypass (a logged-in user
// re-pairs to mint a new device.id and skip the per-device cap).
//
// Sizing at REALTIME_TOKEN_TTL_SECONDS = 3600 (1 h): typical 1–3 device
// account = ~3 mints/h baseline (one refresh per device per ~55 min,
// either via in-channel refresh on the existing socket — reader#47 — or
// via the disconnect-and-reconnect fallback path). 30/h carries ~10×
// headroom for a typical user. A hypothetical 25-device fleet would peak
// near 25–28 mints/h under reconnect-storm conditions; bump this ceiling
// (and the per-device cadence) when single-account fleets exceed ~20
// devices, not on per-user mint count alone.
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

// Per-user budget on catalog requests. Consumed at the /app/api/book-catalog
// handler entry, before any Supabase round-trip — so worst-case DB load
// on cold-miss spam matches the limiter budget rather than the request
// volume, and the budget that gates expensive cover-resolve fan-out
// can't be bypassed by interleaving cheap warm-hit reads. Warm hits
// also consume one unit; 10/min covers normal interactive browsing
// (open a few book pages, hit the API a few times) with headroom;
// bulk patterns are intentionally gated regardless of cache state.
//
// Layered with the per-deployment fail-OPEN limiters
// (catalogOpenLibraryLimiter / catalogGoogleBooksLimiter) inside
// resolveIsbn:
//   - per-deployment fail-open  → protects upstreams from us when
//     Upstash is unhealthy (don't lock everyone out of catalog).
//   - per-user fail-closed      → protects us from a single user;
//     under Upstash outage we'd rather suppress one user's background
//     fan-out than let them monopolize the global budget.
export const catalogUserLimiter = createLimiter({
  window: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "rl:catalog:user",
  failMode: "closed",
});

// 80 req / 5 min — 10 % safety margin under Open Library's 100/5min unauth limit.
// Global key (single shared bucket across all server instances). Fail-open:
// upstash outage → fetch attempted, upstream's own 429 is the next backstop.
export const catalogOpenLibraryLimiter = createLimiter({
  window: Ratelimit.slidingWindow(80, "5 m"),
  prefix: "rl:catalog-openlibrary",
  failMode: "open",
});

// 800 req / day — 20 % safety margin under Google Books' 1k/day free-tier limit.
// Per-day single global bucket. Fail-open for the same reason.
export const catalogGoogleBooksLimiter = createLimiter({
  window: Ratelimit.slidingWindow(800, "1 d"),
  prefix: "rl:catalog-googlebooks",
  failMode: "open",
});

// 18 req / 1 min — 10% margin under iTunes Search API's ~20 req/min per-IP
// undocumented ceiling. Sliding window 1 minute (no daily cap documented).
// Per-deployment single global bucket. Fail-open for the same reason as the
// other catalog upstreams.
export const catalogITunesLimiter = createLimiter({
  window: Ratelimit.slidingWindow(18, "1 m"),
  prefix: "rl:catalog-itunes",
  failMode: "open",
});
