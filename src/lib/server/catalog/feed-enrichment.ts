import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedItem, FeedRow } from "$lib/feed/types";
import { canonicalizeIsbn } from "./isbn";
import { normalizeTitleAuthor } from "./title-author";
import { getCoverUrlsByIsbns, getCoverUrlsByTitleAuthor } from "./view";
import {
  scheduleCatalogResolveIfAllowed,
  type CatalogResolveWork,
} from "./scheduling";
import { logger } from "$lib/server/log";

/**
 * Batch-resolve cover thumbnails for a page of feed rows. Two cache paths
 * are queried in parallel:
 *   - ISBN-bearing rows → `getCoverUrlsByIsbns` against book_catalog.isbn
 *   - ISBN-less rows with title+author → `getCoverUrlsByTitleAuthor` against
 *     book_catalog.normalized_title_author (partial unique index, scope
 *     `isbn IS NULL`) for sideloaded EPUBs.
 *
 * Cold-miss ISBNs schedule `resolveIsbn`; cold-miss (title, author) pairs
 * schedule `resolveTitleAuthor`. A single per-user limiter check gates the
 * combined fan-out so a row mix doesn't double-bill the user's budget.
 *
 * Cosmetic enrichment: any upstream failure falls soft to placeholder
 * (coverUrl=null) — returning 429/503 from a load function would render an
 * error page over already-readable feed content. Mirrors the per-source /
 * per-user rate-limit policy documented at `catalogUserLimiter`.
 */
export async function enrichFeedRowsWithCovers(
  supabase: SupabaseClient,
  userId: string,
  rows: FeedRow[],
): Promise<FeedItem[]> {
  if (rows.length === 0) return [];

  // ISBN-bearing candidates: canonicalize once per raw value.
  const canonByRaw = new Map<string, string>();
  for (const r of rows) {
    if (!r.book_isbn) continue;
    const canon = canonicalizeIsbn(r.book_isbn);
    if (canon) canonByRaw.set(r.book_isbn, canon);
  }
  const uniqueCanon = Array.from(new Set(canonByRaw.values()));

  // Title/author candidates: only ISBN-less rows that carry both fields.
  // Dedupe on the normalized key so duplicate (title, author) across rows
  // produce one lookup and at most one scheduled resolve.
  const taPairsByKey = new Map<string, { title: string; author: string }>();
  for (const r of rows) {
    if (r.book_isbn) continue;
    if (!r.book_title || !r.book_author) continue;
    const key = normalizeTitleAuthor(r.book_title, r.book_author);
    if (!key) continue;
    if (!taPairsByKey.has(key)) {
      taPairsByKey.set(key, { title: r.book_title, author: r.book_author });
    }
  }
  const uniqueTaKeys = Array.from(taPairsByKey.keys());

  let coverUrlsByCanon = new Map<string, string>();
  let coverUrlsByTa = new Map<string, string>();
  let negativeIsbns = new Set<string>();
  let negativeTaKeys = new Set<string>();
  // Track lookup success per branch so a DB-blip on one branch does not
  // cascade into N background resolves for every ISBN / pair on the page.
  // On throw the branch's "missing" list collapses to empty — warmup cron
  // is the retry path. Issue #110.
  let isbnLookupOk = true;
  let taLookupOk = true;
  const lookups: Promise<void>[] = [];
  if (uniqueCanon.length > 0) {
    lookups.push(
      getCoverUrlsByIsbns(supabase, uniqueCanon, "thumbnail")
        .then((res) => {
          coverUrlsByCanon = res.covers;
          negativeIsbns = res.negativeIsbns;
        })
        .catch((err) => {
          isbnLookupOk = false;
          logger().warn(
            { event: "feed_cover_lookup_failed", error: String(err) },
            "feed_cover_lookup_failed",
          );
        }),
    );
  }
  if (uniqueTaKeys.length > 0) {
    lookups.push(
      getCoverUrlsByTitleAuthor(
        supabase,
        Array.from(taPairsByKey.values()),
        "thumbnail",
      )
        .then((res) => {
          coverUrlsByTa = res.covers;
          negativeTaKeys = res.negativeKeys;
        })
        .catch((err) => {
          taLookupOk = false;
          logger().warn(
            { event: "feed_cover_lookup_ta_failed", error: String(err) },
            "feed_cover_lookup_ta_failed",
          );
        }),
    );
  }
  if (lookups.length > 0) await Promise.all(lookups);

  // Subtract both positive cache (covers) and negative cache (storage_path
  // null) from cold-miss candidates. Negative-cache refire is the leak
  // issue #110 calls out — the warmup cron handles retry on a longer cadence
  // than per-request scheduling. A DB-blip on either branch collapses that
  // branch's cold-miss list to empty so the failure doesn't fan out into
  // N background resolves.
  const missingIsbns = isbnLookupOk
    ? uniqueCanon.filter(
        (c) => !coverUrlsByCanon.has(c) && !negativeIsbns.has(c),
      )
    : [];
  const missingTaKeys = taLookupOk
    ? uniqueTaKeys.filter(
        (k) => !coverUrlsByTa.has(k) && !negativeTaKeys.has(k),
      )
    : [];

  const work: CatalogResolveWork[] = [];
  for (const isbn of missingIsbns) work.push({ kind: "isbn", isbn });
  for (const key of missingTaKeys) {
    const pair = taPairsByKey.get(key);
    if (pair) work.push({ kind: "ta", title: pair.title, author: pair.author });
  }
  await scheduleCatalogResolveIfAllowed(userId, work);

  return rows.map((r) => {
    if (r.book_isbn) {
      return {
        ...r,
        coverUrl:
          coverUrlsByCanon.get(canonByRaw.get(r.book_isbn) ?? "") ?? null,
      };
    }
    if (r.book_title && r.book_author) {
      const key = normalizeTitleAuthor(r.book_title, r.book_author);
      if (key) return { ...r, coverUrl: coverUrlsByTa.get(key) ?? null };
    }
    return { ...r, coverUrl: null };
  });
}
