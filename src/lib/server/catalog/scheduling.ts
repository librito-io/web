import { resolveIsbn, resolveTitleAuthor } from "./fetcher";
import { getCatalogMutex } from "./mutex";
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

export type CatalogResolveWork =
  | { kind: "isbn"; isbn: string }
  | { kind: "ta"; title: string; author: string };

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
export async function scheduleCatalogResolveIfAllowed(
  userId: string,
  work: CatalogResolveWork[],
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
    const outcome = await safeLimit(catalogUserLimiter, userId);
    if (outcome.kind !== "ok" || !outcome.result.success) break;
    if (item.kind === "isbn") {
      const isbn = item.isbn;
      runInBackground(async () => {
        const mutex = await mutexPromise;
        await resolveIsbn(admin, isbn, {
          rateLimiters,
          mutex,
          googleBooksApiKey,
        });
      });
    } else {
      const { title, author } = item;
      runInBackground(async () => {
        const mutex = await mutexPromise;
        await resolveTitleAuthor(admin, title, author, {
          rateLimiters,
          mutex,
          googleBooksApiKey,
        });
      });
    }
  }
}
