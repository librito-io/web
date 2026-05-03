import type { PageServerLoad } from "./$types";
import { parseSort, SORT_COOKIE } from "$lib/feed/sort";
import { encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedItem, Sort } from "$lib/feed/types";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { resolveIsbn } from "$lib/server/catalog/fetcher";
import { getCoverUrlsByIsbns } from "$lib/server/catalog/view";
import { getCatalogMutex } from "$lib/server/catalog/mutex";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogUserLimiter,
  safeLimit,
} from "$lib/server/ratelimit";
import { runInBackground } from "$lib/server/wait-until";
import { createAdminClient } from "$lib/server/supabase";

export const load: PageServerLoad = async (event) => {
  const {
    cookies,
    locals: { supabase, safeGetSession },
  } = event;
  const { user } = await safeGetSession();
  const sort: Sort = parseSort(cookies.get(SORT_COOKIE), "recent");

  if (!user) {
    return { items: [] as FeedItem[], nextCursor: null, sort };
  }

  const { data, error } = await supabase.rpc("get_highlight_feed", {
    p_sort: sort,
    p_cursor: null,
    p_limit: 50,
    p_book_hash: null,
  });

  if (error) {
    console.error("get_highlight_feed failed", error);
    return { items: [] as FeedItem[], nextCursor: null, sort };
  }

  const rows = parseFeedRows(data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;

  // Cover enrichment: batch-resolve thumbnails for ISBNs already in
  // book_catalog; schedule resolveIsbn for cold-miss ISBNs (per-user limiter
  // gates the fan-out — silent-skip on denial keeps page rendering with
  // placeholders). Returning 429/503 from a load function would render an
  // error page over already-readable feed content, which is the wrong UX
  // posture for a discretionary cosmetic enrichment. Mirrors the book-detail
  // loader pattern at /app/book/[bookHash]/+page.server.ts:99-118.
  const canonByRaw = new Map<string, string>();
  for (const r of rows) {
    if (!r.book_isbn) continue;
    const canon = canonicalizeIsbn(r.book_isbn);
    if (canon) canonByRaw.set(r.book_isbn, canon);
  }
  const uniqueCanon = Array.from(new Set(canonByRaw.values()));
  let coverUrlsByCanon = new Map<string, string>();
  try {
    coverUrlsByCanon = await getCoverUrlsByIsbns(
      supabase,
      uniqueCanon,
      "thumbnail",
    );
  } catch (err) {
    console.warn("feed_cover_lookup_failed", { error: String(err) });
  }

  const missing = uniqueCanon.filter((c) => !coverUrlsByCanon.has(c));
  if (missing.length > 0) {
    const outcome = await safeLimit(catalogUserLimiter, user.id);
    const allowed = outcome.kind === "ok" && outcome.result.success;
    if (allowed) {
      const admin = createAdminClient();
      const mutex = await getCatalogMutex();
      for (const isbn of missing) {
        runInBackground(event, () =>
          resolveIsbn(admin, isbn, {
            rateLimiters: {
              openLibrary: catalogOpenLibraryLimiter,
              googleBooks: catalogGoogleBooksLimiter,
            },
            mutex,
          }).then(() => undefined),
        );
      }
    }
  }

  const items: FeedItem[] = rows.map((r) => ({
    ...r,
    coverUrl: r.book_isbn
      ? (coverUrlsByCanon.get(canonByRaw.get(r.book_isbn) ?? "") ?? null)
      : null,
  }));

  return { items, nextCursor, sort };
};
