import { Client as QStashClient } from "@upstash/qstash";
import * as Sentry from "@sentry/sveltekit";
import { catalogRateLimiters, dispatchResolve } from "./dispatch";
import { getCatalogMutex } from "./mutex";
import type { ResolveCtx, TrackedField } from "./types";
import { catalogUserLimiter, safeLimit } from "$lib/server/ratelimit";
import { runInBackground } from "$lib/server/wait-until";
import { createAdminClient } from "$lib/server/supabase";
import { logger } from "$lib/server/log";
// QSTASH_TOKEN + QSTASH_CONSUMER_URL are Sensitive in Vercel; the others
// (GOOGLE_BOOKS_API_KEY etc.) follow the same rule. Read at runtime via
// dynamic/private — `vercel pull` redacts Sensitive vars to empty strings
// and static/private would bake the empty into prebuilt deploys.
import { env as privateEnv } from "$env/dynamic/private";

// ISBN-keyed work item carries optional `ctx` (title + author) so the
// resolver can promote a pre-existing TA-keyed catalog row to ISBN-keyed
// at the data layer (refit 2026-05-27 PR3) — replacing the display-side
// fallthrough that previously masked the duplicate-row gap. `fields`
// scopes the resolver to a subset of tracked fields; consumed by the
// replay cron (PR4) so a partial-failure row only re-walks the legs whose
// TTL is up. Undefined = walk every tracked field per shouldAttempt.
export type CatalogResolveWork =
  | { kind: "isbn"; isbn: string; ctx?: ResolveCtx; fields?: TrackedField[] }
  | {
      kind: "ta";
      title: string;
      author: string;
      fields?: TrackedField[];
    };

/**
 * Optional behavior overrides for `scheduleCatalogResolveIfAllowed`.
 */
export interface ScheduleOpts {
  /**
   * When true, skip the per-item `safeLimit(catalogUserLimiter, userId)`
   * check entirely. Per-source limiters (OpenLibrary, GoogleBooks,
   * iTunes) still apply — those are the upstream-protection budgets.
   *
   * Only cron-driven callers using `SERVICE_USER_ID` set this; a 100-row
   * replay batch would otherwise be capped at the 10/min per-user limit.
   * Default `false`.
   */
  bypassUserLimit?: boolean;
}

/**
 * Schedule per-user, mutex-deduped catalog resolves.
 *
 * Two branches, selected by env-presence (the feature-flag):
 *
 *   - QSTASH_TOKEN + QSTASH_CONSUMER_URL set →
 *       publish one message per work item via `batchJSON`. QStash drains
 *       at flowControl parallelism=2, retries 2× on 5xx, lands in DLQ on
 *       exhaust. Each consumer invocation is an independent Vercel
 *       function with its own 300s budget — no AbortError across cohort.
 *
 *   - either env var unset →
 *       inline `runInBackground` fan-out (today's behavior). Preserved
 *       for self-hosters, local dev, and preview deploys.
 *
 * Per-user `safeLimit` runs in BOTH branches before the work splits —
 * limiter-denied items are dropped before publish, bounding the daily
 * QStash message volume against the per-user budget. Break-on-deny
 * matches issue #110 semantics (a 50-item fan-out consumes 50 tokens,
 * exits as soon as the user's budget is exhausted; fail-open and
 * fail-closed outcomes both bail).
 *
 * Cosmetic-enrichment posture: publish failures (network, QStash 5xx)
 * are logged + Sentry-captured + swallowed. Surfacing them would render
 * an error page over readable feed content (see
 * feed-enrichment.ts:23-28). Recovery layer is the nightly replay cron
 * via the field-state TTL ladder — see catalog-replay/+server.ts.
 */
export async function scheduleCatalogResolveIfAllowed(
  userId: string,
  work: CatalogResolveWork[],
  opts: ScheduleOpts = {},
): Promise<void> {
  if (work.length === 0) return;

  const permitted: CatalogResolveWork[] = [];
  for (const item of work) {
    if (!opts.bypassUserLimit) {
      const outcome = await safeLimit(catalogUserLimiter, userId);
      if (outcome.kind !== "ok" || !outcome.result.success) break;
    }
    permitted.push(item);
  }
  if (permitted.length === 0) return;

  // Inline fallback: both env vars required. QSTASH_TOKEN alone with no
  // CONSUMER_URL would publish to "", and a preview deploy with only
  // QSTASH_TOKEN set would publish to wherever — refusing to attempt
  // publish when either is missing is the safe default.
  if (!privateEnv.QSTASH_TOKEN || !privateEnv.QSTASH_CONSUMER_URL) {
    const admin = createAdminClient();
    const mutexPromise = getCatalogMutex();
    const googleBooksApiKey = privateEnv.GOOGLE_BOOKS_API_KEY;
    for (const item of permitted) {
      runInBackground(async () => {
        const mutex = await mutexPromise;
        const deps = {
          rateLimiters: catalogRateLimiters,
          mutex,
          googleBooksApiKey,
        };
        await dispatchResolve(admin, deps, userId, item);
      });
    }
    logger().info(
      {
        event: "catalog.queue.published",
        userId,
        count: permitted.length,
        path: "inline",
      },
      "catalog.queue.published",
    );
    return;
  }

  // QStash path. batchJSON publishes N independent messages in one HTTP
  // round-trip; each message has its own retry budget + DLQ slot.
  // flowControl pins parallelism per queue key — replaces the deprecated
  // queue-upsert `parallelism` config, so no provisioning step is needed.
  const qstash = new QStashClient({ token: privateEnv.QSTASH_TOKEN });
  try {
    await qstash.batchJSON(
      permitted.map((item) => ({
        queue: "catalog-resolve",
        url: privateEnv.QSTASH_CONSUMER_URL as string,
        body: { userId, item },
        retries: 2,
        flowControl: { key: "catalog-resolve", parallelism: 2 },
      })),
    );
    logger().info(
      {
        event: "catalog.queue.published",
        userId,
        count: permitted.length,
        path: "qstash",
      },
      "catalog.queue.published",
    );
  } catch (err) {
    // Cosmetic-enrichment posture: swallow. The nightly replay cron is
    // the recovery layer. Do NOT fall back to inline runInBackground —
    // that would create an invisible recovery channel that contradicts
    // the env-presence feature-flag invariant (see spec § Producer).
    logger().warn(
      {
        event: "catalog.queue.publish_failed",
        userId,
        count: permitted.length,
        error: err instanceof Error ? err.message : String(err),
      },
      "catalog.queue.publish_failed",
    );
    Sentry.captureException(err, {
      tags: { queue: "catalog-resolve", phase: "publish" },
    });
  }
}
