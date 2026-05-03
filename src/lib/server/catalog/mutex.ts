import type { Redis } from "@upstash/redis";

/**
 * Per-key coordination primitive used to dedupe concurrent catalog
 * resolves across server instances. Two simultaneous tabs (or a tab plus
 * the warmup cron, or two cron runs across overlapping cadences) hitting
 * the same uncached ISBN would otherwise each fire full upstream pipelines
 * (Open Library data + search + cover, Google Books volumes + cover) and
 * then race to upsert. Both consume per-source rate-limit budget against
 * upstreams; the second's storage upload is dedup'd by sha256 inside
 * `persistCover` but the upstream calls are not refundable.
 *
 * The mutex sits between the cache-miss guard and the per-source
 * `tryAcquire` checks inside `resolveIsbn` / `resolveTitleAuthor`. Winner
 * runs the upstream pipeline; loser short-circuits to a "no progress this
 * round" result that the API handler / page loader / cron all already
 * treat as a soft skip. See audit `docs/audits-wip/2026-05-03-...` row #12.
 */
export interface CatalogMutex {
  /**
   * Try to acquire `key` exclusively. Returns true if won, false if
   * another runner holds it. Implementations MUST fail-OPEN on transport
   * errors (return true) to match the per-source rate limiter posture —
   * an Upstash blip should not collapse all callers to placeholder, since
   * the per-source fail-OPEN limiter is also down during the same blip.
   */
  acquire(key: string): Promise<boolean>;
  /**
   * Release the lock. Best-effort: the TTL is the backstop if release
   * fails (process killed, function timeout, transport error).
   */
  release(key: string): Promise<void>;
}

const LOCK_TTL_SECONDS = 30;

/**
 * Upstash-backed mutex. Uses `SET key 1 NX EX 30` semantically — the
 * Upstash REST client returns "OK" when the key was set and `null` when
 * `nx: true` and the key already exists.
 *
 * TTL rationale: OL+GB fetches typically <5s each and storage upload <2s,
 * so a normal full resolve completes in <10s. 30s leaves margin for slow
 * upstreams without leaving long zombie locks if the runner crashes
 * mid-resolve. Tune via the constant if cold-resolve latency moves.
 */
export function createUpstashMutex(
  redis: Pick<Redis, "set" | "del">,
): CatalogMutex {
  return {
    async acquire(key) {
      try {
        const r = await redis.set(key, "1", {
          nx: true,
          ex: LOCK_TTL_SECONDS,
        });
        // Upstash returns "OK" on success, null when nx and the key
        // already exists. Any other shape is treated as a failure to
        // acquire defensively.
        return r === "OK";
      } catch (err) {
        // Fail-OPEN: an Upstash error must not return all callers as
        // cold-miss. The per-source limiter (fail-OPEN) is also down
        // during the same blip, so the byte-level sha dedup in
        // `persistCover` is the remaining backstop against duplicated
        // uploads — the duplicated upstream fetches under blip are an
        // acceptable cost for keeping covers materializing during outages.
        console.warn("catalog_mutex_acquire_failed", {
          key,
          error: String(err),
        });
        return true;
      }
    },
    async release(key) {
      try {
        await redis.del(key);
      } catch (err) {
        // TTL is the backstop. Don't propagate — release runs in a
        // `finally` and an unhandled throw here would mask the original
        // resolver error.
        console.warn("catalog_mutex_release_failed", {
          key,
          error: String(err),
        });
      }
    },
  };
}

/**
 * No-op mutex for call sites that opt out of coordination (and as a
 * safe default for tests that don't exercise concurrency). Always wins.
 */
export const noopMutex: CatalogMutex = {
  async acquire() {
    return true;
  },
  async release() {
    /* no-op */
  },
};

/**
 * Lazy singleton — production call sites (API handler, page loader,
 * cron) all share one mutex backed by the existing Upstash `redis`
 * client. Lazy-imported to keep `mutex.ts` free of `$env/static/private`
 * pulls (which would force every test file importing it to mock those
 * envs even when concurrency isn't being exercised).
 */
let cachedProdMutex: CatalogMutex | null = null;
export async function getCatalogMutex(): Promise<CatalogMutex> {
  if (cachedProdMutex) return cachedProdMutex;
  const { redis } = await import("$lib/server/ratelimit");
  cachedProdMutex = createUpstashMutex(redis);
  return cachedProdMutex;
}

/**
 * @internal — exported for tests that need to reset the singleton
 * between cases. Production code should not call this.
 */
export function _resetCatalogMutexForTests(): void {
  cachedProdMutex = null;
}

/**
 * In-memory mutex for unit tests. Two `resolveIsbn` calls sharing the
 * same `createTestMutex()` instance compete on the same key set, which
 * is the contract that `tests/lib/catalog/fetcher-mutex.test.ts` locks.
 * Exposes the held-set so tests can assert lock state without timing.
 */
export function createTestMutex(): CatalogMutex & {
  _held: Set<string>;
  acquire: ReturnType<typeof spyableAcquire>;
  release: ReturnType<typeof spyableRelease>;
} {
  const held = new Set<string>();
  const acquire = spyableAcquire(held);
  const release = spyableRelease(held);
  return {
    _held: held,
    acquire,
    release,
  };
}

// Helper factories typed so `_held` and the spy-shaped functions stay in
// sync without sprinkling `vi` imports through src/. Tests that need spy
// metadata can wrap with `vi.spyOn(mutex, 'acquire')`.
function spyableAcquire(held: Set<string>) {
  return async (key: string): Promise<boolean> => {
    if (held.has(key)) return false;
    held.add(key);
    return true;
  };
}

function spyableRelease(held: Set<string>) {
  return async (key: string): Promise<void> => {
    held.delete(key);
  };
}
