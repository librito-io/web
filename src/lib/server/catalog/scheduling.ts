import { resolveIsbn, resolveTitleAuthor } from "./fetcher";
import { getCatalogMutex } from "./mutex";
import type { ResolveCtx, TrackedField } from "./types";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogITunesLimiter,
  catalogUserLimiter,
  safeLimit,
} from "$lib/server/ratelimit";
import { runInBackground } from "$lib/server/wait-until";
import { createAdminClient } from "$lib/server/supabase";
// GOOGLE_BOOKS_API_KEY is Sensitive in Vercel; static-imported sensitive
// vars bake empty strings into prebuilt deploys. Read at runtime via
// dynamic/private. Anonymous Google Books quota is 0/day per project, so
// missing key silently degrades the entire premium-cover + description path.
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
 * Schedule per-user, mutex-deduped catalog resolves in the background.
 * Single entry point for the `safeLimit + createAdminClient +
 * getCatalogMutex + runInBackground` boilerplate previously triplicated
 * across the feed enrichment path and the book detail loader.
 *
 * Per-item `safeLimit(catalogUserLimiter, userId)` with break-on-deny
 * preserves the issue #110 semantics: a 50-item fan-out consumes 50
 * tokens (not 1), and exits the loop as soon as the user's per-minute
 * budget is exhausted. Failed-open / failed-closed outcomes both bail —
 * fan-out volume during an Upstash blip is bounded.
 *
 * Mutex acquisition lives inside each `runInBackground` callback so the
 * request-handling path does not wait on the lazy Upstash singleton
 * init; the shared `mutexPromise` is reused across the cohort within
 * one helper invocation.
 *
 * Cosmetic enrichment posture: all errors are absorbed inside
 * `runInBackground` (see `wait-until.ts`). Callers never see a thrown
 * resolve failure — the cold-miss work is best-effort.
 */
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

export async function scheduleCatalogResolveIfAllowed(
  userId: string,
  work: CatalogResolveWork[],
  opts: ScheduleOpts = {},
): Promise<void> {
  if (work.length === 0) return;
  const admin = createAdminClient();
  const mutexPromise = getCatalogMutex();
  const rateLimiters = {
    openLibrary: catalogOpenLibraryLimiter,
    googleBooks: catalogGoogleBooksLimiter,
    itunes: catalogITunesLimiter,
  };
  const googleBooksApiKey = privateEnv.GOOGLE_BOOKS_API_KEY;

  for (const item of work) {
    if (!opts.bypassUserLimit) {
      const outcome = await safeLimit(catalogUserLimiter, userId);
      if (outcome.kind !== "ok" || !outcome.result.success) break;
    }
    runInBackground(async () => {
      const mutex = await mutexPromise;
      const innerDeps = { rateLimiters, mutex, googleBooksApiKey };
      if (item.kind === "isbn") {
        await resolveIsbn(admin, item.isbn, innerDeps, item.ctx, item.fields);
      } else {
        await resolveTitleAuthor(
          admin,
          item.title,
          item.author,
          innerDeps,
          item.fields,
        );
      }
    });
  }
}
