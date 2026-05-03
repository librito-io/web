import type { RequestHandler } from "@sveltejs/kit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { parseSort } from "$lib/feed/sort";
import { decodeCursor, encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedItem } from "$lib/feed/types";
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

export const GET: RequestHandler = async (event) => {
  const {
    url,
    locals: { supabase, safeGetSession },
  } = event;
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Sign in required");

  const sort = parseSort(url.searchParams.get("sort"), "recent");
  const cursorParam = url.searchParams.get("cursor");
  const cursor = decodeCursor(cursorParam);
  if (cursorParam && cursor === null) {
    return jsonError(400, "bad_cursor", "Invalid cursor");
  }
  const bookHash = url.searchParams.get("book_hash");

  const { data, error } = await supabase.rpc("get_highlight_feed", {
    p_sort: sort,
    p_cursor: cursor,
    p_limit: 50,
    p_book_hash: bookHash,
  });

  if (error) {
    console.error("/app/feed rpc error", error);
    return jsonError(500, "rpc_failed", "Feed query failed");
  }

  const rows = parseFeedRows(data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;

  // Cover enrichment: same posture as the loader at /app/+page.server.ts —
  // silent-skip on per-user limiter denial. Pagination consistency requires
  // the API to mirror the loader; otherwise a denied scroll-fetch would
  // surface as a 429 over working feed content, breaking the infinite
  // scroll. Cosmetic enrichment fails-soft to placeholder.
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

  return jsonSuccess({ items, nextCursor });
};
