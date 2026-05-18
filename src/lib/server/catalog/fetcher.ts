import type { SupabaseClient } from "@supabase/supabase-js";
import type { LimitResult, RateLimiter } from "$lib/server/ratelimit";
import { canonicalizeIsbn } from "./isbn";
import { stripMarketingCruft } from "./cleanup";
import {
  fetchOpenLibraryByIsbn,
  searchOpenLibraryByIsbn,
  searchOpenLibraryByTitleAuthor,
  fetchOpenLibraryWork,
  fetchOpenLibraryCoverBytes,
  fetchOpenLibraryCoverBytesByIsbn,
} from "./openlibrary";
import {
  fetchGoogleBooksByIsbn,
  fetchGoogleBooksByTitleAuthor,
  fetchGoogleBooksCoverBytes,
  selectBestGoogleImageLink,
} from "./googlebooks";
import {
  extractOpenLibraryMetadata,
  extractGoogleBooksMetadata,
} from "./extract";
import { normalizeTitleAuthor } from "./title-author";
import {
  hasCoverStorage,
  type BookCatalogRowFields,
  type CatalogMetadata,
  type CoverSource,
  type CoverStorageBackend,
  type GoogleBooksItem,
  type OpenLibraryDataDoc,
  type OpenLibraryWork,
} from "./types";
import { uploadCover as defaultUploadCover } from "$lib/server/cover-storage";
import { sha256Hex } from "./sha";
import { type CatalogMutex, noopMutex } from "./mutex";
import { logger } from "$lib/server/log";
import { fetchItunesByIsbn, fetchItunesCoverBytes } from "./itunes";
import { decodeImageDimensions } from "./dimensions";

export class InvalidIsbnError extends Error {
  constructor(raw: string) {
    super(`InvalidIsbn: ${raw}`);
  }
}

const NEGATIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ResolveDeps {
  fetchFn?: typeof fetch;
  rateLimiters: {
    openLibrary: Pick<RateLimiter, "limit">;
    googleBooks: Pick<RateLimiter, "limit">;
    itunes: Pick<RateLimiter, "limit">;
  };
  coverStorage?: { uploadCover: typeof defaultUploadCover };
  googleBooksApiKey?: string;
  now?: () => Date;
  /**
   * Per-key mutex used to dedupe concurrent resolves of the same ISBN /
   * (title, author) across server instances. Optional — defaults to
   * `noopMutex`, which always wins. Production call sites pass a real
   * Upstash-backed mutex; unit tests that don't exercise concurrency may
   * omit it. See `./mutex.ts` for the contract.
   */
  mutex?: CatalogMutex;
}

export interface ResolveResult {
  cached: boolean;
  rateLimited: boolean;
  row: Partial<BookCatalogRowFields>;
}

type CoverBytes = { bytes: Uint8Array; mime: string };
type StorageRecord = {
  storage_path: string;
  backend: CoverStorageBackend;
  image_sha256: string;
};

async function selectByIsbn(
  supabase: SupabaseClient,
  isbn: string,
): Promise<Partial<BookCatalogRowFields> | null> {
  const { data, error } = await supabase
    .from("book_catalog")
    .select("*")
    .eq("isbn", isbn)
    .maybeSingle();
  if (error) throw new Error(`book_catalog select: ${error.message}`);
  return (data as Partial<BookCatalogRowFields> | null) ?? null;
}

async function selectBySha(
  supabase: SupabaseClient,
  sha: string,
): Promise<{
  storage_path: string;
  cover_storage_backend: CoverStorageBackend;
} | null> {
  const { data, error } = await supabase
    .from("book_catalog")
    .select("storage_path, cover_storage_backend")
    .eq("image_sha256", sha)
    .not("storage_path", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`book_catalog selectBySha: ${error.message}`);
  // The `.not("storage_path", "is", null)` filter combined with the DB-level
  // `book_catalog_storage_consistency` CHECK (`storage_path` and
  // `cover_storage_backend` are coupled — both NULL or both non-null)
  // guarantees both fields are non-null at runtime. The Supabase row type
  // still types them as nullable, so narrow via `hasCoverStorage` rather
  // than a `!` assertion.
  const row = data as {
    storage_path: string | null;
    cover_storage_backend: CoverStorageBackend | null;
  } | null;
  if (!row || !hasCoverStorage(row)) return null;
  return {
    storage_path: row.storage_path,
    cover_storage_backend: row.cover_storage_backend,
  };
}

function isFreshNegative(
  row: Partial<BookCatalogRowFields>,
  now: Date,
): boolean {
  if (row.storage_path) return false;
  if (!row.last_attempted_at) return false;
  const last = new Date(row.last_attempted_at).getTime();
  return now.getTime() - last < NEGATIVE_CACHE_TTL_MS;
}

async function tryAcquire(
  limiter: Pick<RateLimiter, "limit">,
): Promise<boolean> {
  try {
    const limitResult = (await limiter.limit("catalog")) as LimitResult;
    return limitResult.success;
  } catch {
    return true; // fail-open per limiter policy
  }
}

/**
 * Build a memoized GB volume fetcher used by both the cover chain and the
 * description-enrichment path within a single resolve (issue #203).
 *
 * Caches only on a successful fetch. Rate-limit denial or upstream error
 * does NOT mark the slot consumed, so a second consumer is free to retry
 * its own tryAcquire — matches the issue's explicit edge case where the
 * cover chain was denied but description still wants to try.
 *
 * Side-effect: when this fetcher runs, it consumes one GB rate-limit
 * token via `tryAcquire`. Subsequent calls within the same resolve hit
 * the memo (zero additional tokens) once a fetch has succeeded.
 */
function memoizeGoogleBooksVolume(
  deps: ResolveDeps,
  fetcher: () => Promise<GoogleBooksItem | null>,
): () => Promise<GoogleBooksItem | null> {
  let cached: GoogleBooksItem | null = null;
  return async () => {
    if (cached) return cached;
    if (!(await tryAcquire(deps.rateLimiters.googleBooks))) return null;
    try {
      const v = await fetcher();
      if (v) cached = v;
      return v;
    } catch {
      return null;
    }
  };
}

/**
 * Materialize cover bytes into the storage backend, deduping by sha256.
 *
 * The dedup check pairs with the DB-level `image_sha256` index: if any
 * existing row already references the same bytes, reuse its storage_path
 * instead of uploading again. This collapses identical covers across
 * editions (paperback / hardcover / reprints) to one stored object.
 *
 * Returns `null` when there are no bytes to persist (negative-cache row).
 */
async function persistCover(
  supabase: SupabaseClient,
  coverBytes: CoverBytes | null,
  upload: typeof defaultUploadCover,
): Promise<StorageRecord | null> {
  if (!coverBytes) return null;
  const sha = await sha256Hex(coverBytes.bytes);
  const dedup = await selectBySha(supabase, sha);
  if (dedup) {
    return {
      storage_path: dedup.storage_path,
      backend: dedup.cover_storage_backend,
      image_sha256: sha,
    };
  }
  return upload(coverBytes.bytes, coverBytes.mime, {});
}

// ─── Cover resolver chain ─────────────────────────────────────────────────────

// Width thresholds for tiered floor. Largest variant we serve is xlarge
// (1200×1800). Premium tier = native xlarge support. Basic tier = native
// thumbnail/medium/large support but xlarge would upscale (handled via
// variant fallback in cover-storage.ts). Below basic = reject; negative-cache.
const FLOOR_PREMIUM = 1200;
const FLOOR_BASIC = 300;

/**
 * Known Google Books "generic placeholder" cover sha256s (issue #207).
 *
 * GoogleBooks returns a fallback image for some volumes that have no real
 * cover; the bytes clear the basic-tier width floor (300 px) so the chain
 * accepts them and unrelated ISBNs end up sharing one image. We reject by
 * sha — when matched, `tryGoogleBooksExtraLarge` returns null and the
 * resolver chain advances to iTunes / OpenLibrary.
 *
 * Exported so tests can register additional fixture-derived shas; the
 * exported Set is the runtime source of truth, NOT a snapshot.
 * Production code must never mutate it outside the initial population
 * below — extend the literal list when a new placeholder hash is
 * confirmed.
 */
export const KNOWN_GB_PLACEHOLDER_SHAS = new Set<string>([
  // First confirmed placeholder — shared by 4 unrelated ISBNs in the
  // PR #205 backfill batch (2026-05-17). 575 px wide.
  "3efa8c43e5b4348f303a528c81adf435f0111ea752fe9f0f6241478b60987fa6",
]);

interface CoverResolution {
  bytes: Uint8Array;
  mime: string;
  source: CoverSource;
  width: number;
  /** Volume / cover identifiers to record alongside source (where available). */
  googleVolumeId?: string;
  openLibraryCoverId?: number;
}

interface CoverChainContext {
  isbn?: string;
  title?: string;
  author?: string;
  /** OL cover_id discovered upstream (search-by-isbn or data document);
   *  the chain uses this when falling back to OL `-L`. */
  openLibraryCoverId?: number;
  /** Memoized GB volume fetcher (issue #203). The chain's GB attempt and
   *  description enrichment share the same callback; the first successful
   *  fetch caches the volume so the second consumer hits memo instead of
   *  burning a second upstream call and rate-limit token. Caller (resolve*)
   *  owns the memo via closure capture. */
  fetchGbVolume: () => Promise<GoogleBooksItem | null>;
}

async function tryGoogleBooksExtraLarge(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  const gb = await ctx.fetchGbVolume();
  if (!gb?.volumeInfo?.imageLinks) return null;
  const link = selectBestGoogleImageLink(gb.volumeInfo.imageLinks);
  if (!link) return null;
  let bytes: { bytes: Uint8Array; mime: string } | null;
  try {
    bytes = await fetchGoogleBooksCoverBytes(link, {
      fetchFn: deps.fetchFn,
      minWidth,
    });
  } catch {
    return null;
  }
  if (!bytes) return null;
  const dims = decodeImageDimensions(bytes.bytes);
  if (!dims) return null;

  // Reject known GB placeholder bytes (issue #207). The sha is computed
  // again later in `persistCover` for byte-level dedup; the redundancy
  // is intentional — checking earlier lets the chain fall through to
  // iTunes / OpenLibrary instead of materializing a generic image.
  const sha = await sha256Hex(bytes.bytes);
  if (KNOWN_GB_PLACEHOLDER_SHAS.has(sha)) {
    logger().warn(
      {
        event: "catalog_googlebooks_placeholder_rejected",
        isbn: ctx.isbn,
        title: ctx.title,
        author: ctx.author,
        sha,
        width: dims.width,
      },
      "catalog_googlebooks_placeholder_rejected",
    );
    return null;
  }

  return {
    bytes: bytes.bytes,
    mime: bytes.mime,
    source: "google_books",
    width: dims.width,
    googleVolumeId: gb.id,
  };
}

async function tryItunes(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  // iTunes lookup keyed on ISBN only — the lookup endpoint is ISBN-specific.
  if (!ctx.isbn) return null;
  if (!(await tryAcquire(deps.rateLimiters.itunes))) return null;
  let lookup: Awaited<ReturnType<typeof fetchItunesByIsbn>>;
  try {
    lookup = await fetchItunesByIsbn(ctx.isbn, { fetchFn: deps.fetchFn });
  } catch {
    return null;
  }
  if (!lookup?.artworkUrl100) return null;
  let bytes: { bytes: Uint8Array; mime: string } | null;
  try {
    bytes = await fetchItunesCoverBytes(lookup.artworkUrl100, {
      fetchFn: deps.fetchFn,
      minWidth,
    });
  } catch {
    return null;
  }
  if (!bytes) return null;
  const dims = decodeImageDimensions(bytes.bytes);
  if (!dims) return null;
  return {
    bytes: bytes.bytes,
    mime: bytes.mime,
    source: "itunes",
    width: dims.width,
  };
}

async function tryOpenLibrary(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  if (!ctx.openLibraryCoverId) return null;
  let bytes: { bytes: Uint8Array; mime: string } | null;
  try {
    bytes = await fetchOpenLibraryCoverBytes(ctx.openLibraryCoverId, {
      fetchFn: deps.fetchFn,
      minWidth,
    });
  } catch {
    return null;
  }
  if (!bytes) return null;
  const dims = decodeImageDimensions(bytes.bytes);
  if (!dims) return null;
  return {
    bytes: bytes.bytes,
    mime: bytes.mime,
    source: ctx.isbn ? "openlibrary_isbn" : "openlibrary_search_title",
    width: dims.width,
    openLibraryCoverId: ctx.openLibraryCoverId,
  };
}

async function tryOpenLibraryDirectIsbn(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  // Title/author flow has no ISBN — this tier auto-skips there.
  if (!ctx.isbn) return null;
  let bytes: { bytes: Uint8Array; mime: string } | null;
  try {
    bytes = await fetchOpenLibraryCoverBytesByIsbn(ctx.isbn, {
      fetchFn: deps.fetchFn,
      minWidth,
    });
  } catch {
    return null;
  }
  if (!bytes) return null;
  const dims = decodeImageDimensions(bytes.bytes);
  if (!dims) return null;
  return {
    bytes: bytes.bytes,
    mime: bytes.mime,
    source: "openlibrary_isbn_direct",
    width: dims.width,
  };
}

/** Walk sources in priority order; each source has the same `minWidth` floor
 *  applied. First source whose decoded width meets `minWidth` wins. Null
 *  when all sources fail. */
async function resolveCoverChain(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  return (
    (await tryOpenLibraryDirectIsbn(deps, ctx, minWidth)) ??
    (await tryGoogleBooksExtraLarge(deps, ctx, minWidth)) ??
    (await tryItunes(deps, ctx, minWidth)) ??
    (await tryOpenLibrary(deps, ctx, minWidth))
  );
}

/** Two-pass: try premium floor (1200), fall back to basic floor (300).
 *
 * Worst-case budget consumption per ISBN is 8 upstream cover attempts
 * (4 chain tiers × 2 passes). The OL rate-limit token is acquired ONCE
 * before entering the chain and covers both OL tiers (direct-ISBN and
 * cover-id), so per-pass token cost is 3 (OL, GB, iTunes); 2 passes
 * consume 6 tokens worst-case. Acceptable trade-off because: (a) most
 * popular books succeed at the premium pass first try (one attempt per
 * source), (b) the alternative of a single liberal floor would store
 * low-res sources that fail the `xlarge` variant requirement,
 * (c) per-source limiters fail-OPEN — exhaustion doesn't lock callers
 * out. See issue #199 design notes for full tier rationale. */
async function resolveCoverWithTiering(
  deps: ResolveDeps,
  ctx: CoverChainContext,
): Promise<CoverResolution | null> {
  return (
    (await resolveCoverChain(deps, ctx, FLOOR_PREMIUM)) ??
    (await resolveCoverChain(deps, ctx, FLOOR_BASIC))
  );
}

// ─── Description enrichment (decoupled from cover) ───────────────────────────

/**
 * Enrich `metadata.description` via Google Books when OL left it empty.
 *
 * Cover is intentionally NOT fetched here — cover resolution now lives
 * entirely in the resolver chain (`resolveCoverWithTiering`). This helper
 * is single-responsibility: description text only.
 *
 * `do_not_refetch_description` gates description text. When set, GB is
 * consulted for no-op (we skip early), preserving behavior for takedown'd
 * ISBNs without making an unnecessary API call.
 *
 * Per-source rate-limit budget is checked via `tryAcquire` (fail-open).
 * All upstream errors are caught and logged.
 */
async function enrichDescriptionWithGoogleBooks(
  metadata: CatalogMetadata,
  fetchVolume: () => Promise<GoogleBooksItem | null>,
  opts: {
    do_not_refetch_description: boolean;
    logCtx: Record<string, unknown>;
  },
): Promise<void> {
  if (metadata.description) return;
  if (opts.do_not_refetch_description) {
    // Issue #206: surface the takedown-flag skip so a row that has the
    // flag set unexpectedly (e.g. carryover after a reset that didn't
    // touch `do_not_refetch_description = false`) is visible in logs
    // rather than only via a downstream NULL description.
    logger().warn(
      {
        event: "catalog_description_skipped_takedown_flag",
        ...opts.logCtx,
      },
      "catalog_description_skipped_takedown_flag",
    );
    return;
  }
  // Rate-limit gating moved into the memoized `fetchVolume` callback
  // (issue #203). If the cover chain already paid the token, this is a
  // memo hit; if it didn't, `fetchVolume` will tryAcquire on its own.
  try {
    const gb = await fetchVolume();
    if (!gb) {
      logger().warn(
        {
          event: "catalog_description_no_gb_volume",
          ...opts.logCtx,
        },
        "catalog_description_no_gb_volume",
      );
      return;
    }
    const gbMeta = extractGoogleBooksMetadata(gb);
    if (!gbMeta.description) {
      logger().info(
        {
          event: "catalog_description_gb_volume_no_description",
          ...opts.logCtx,
          google_volume_id: gbMeta.google_volume_id,
        },
        "catalog_description_gb_volume_no_description",
      );
      return;
    }
    metadata.description_raw = gbMeta.description;
    metadata.description = stripMarketingCruft(gbMeta.description);
    metadata.description_provider = "google_books";
    metadata.google_volume_id = gbMeta.google_volume_id;
  } catch (err) {
    logger().warn(
      {
        event: "catalog_googlebooks_failed",
        ...opts.logCtx,
        error: String(err),
      },
      "catalog_googlebooks_failed",
    );
  }
}

// ─── OL cover_id discovery (metadata only — no byte fetch) ───────────────────

/**
 * Discover the Open Library cover_id for an ISBN from the data document or
 * the search-by-isbn endpoint. Mutates `metadata` with search-derived
 * title/author when found. Does NOT fetch cover bytes — that is the chain's
 * responsibility.
 *
 * Returns the cover_id (for the chain context) or null when not found.
 */
async function discoverOpenLibraryCoverId(
  olData: { cover?: { large?: string } } | null,
  isbn: string,
  metadata: CatalogMetadata,
  deps: ResolveDeps,
): Promise<number | null> {
  let coverId: number | undefined;

  const coverLargeUrl = olData?.cover?.large;
  if (coverLargeUrl) {
    const match = coverLargeUrl.match(/\/id\/(\d+)-/);
    if (match) coverId = Number(match[1]);
  }
  if (!coverId) {
    let search: Awaited<ReturnType<typeof searchOpenLibraryByIsbn>> = null;
    try {
      search = await searchOpenLibraryByIsbn(isbn, { fetchFn: deps.fetchFn });
    } catch (err) {
      logger().warn(
        {
          event: "catalog_openlibrary_search_failed",
          isbn,
          error: String(err),
        },
        "catalog_openlibrary_search_failed",
      );
    }
    if (search?.cover_i) {
      coverId = search.cover_i;
      if (!metadata.title && search.title) metadata.title = search.title;
      if (!metadata.author && search.author_name?.length) {
        metadata.author = search.author_name.join(", ");
      }
    }
  }

  if (coverId) metadata.openlibrary_cover_id = coverId;
  return coverId ?? null;
}

/**
 * Fetch the Open Library data document and (if linked) its work record.
 *
 * The work fetch is best-effort — it adds description and subjects but
 * is not required for a positive resolution.
 */
async function loadOpenLibraryData(
  isbn: string,
  deps: ResolveDeps,
): Promise<{
  olData: OpenLibraryDataDoc | null;
  olWork: OpenLibraryWork | null;
}> {
  const olData = await fetchOpenLibraryByIsbn(isbn, { fetchFn: deps.fetchFn });
  let olWork: OpenLibraryWork | null = null;
  const workKey = olData?.works?.[0]?.key;
  const id = workKey?.replace(/^\/works\//, "");
  if (id) {
    try {
      olWork = await fetchOpenLibraryWork(id, { fetchFn: deps.fetchFn });
    } catch {
      /* tolerate work fetch errors */
    }
  }
  return { olData, olWork };
}

export async function resolveIsbn(
  supabase: SupabaseClient,
  rawIsbn: string,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  const isbn = canonicalizeIsbn(rawIsbn);
  if (!isbn) throw new InvalidIsbnError(rawIsbn);

  const now = (deps.now ?? (() => new Date()))();
  const upload = deps.coverStorage?.uploadCover ?? defaultUploadCover;
  const mutex = deps.mutex ?? noopMutex;

  const existing = await selectByIsbn(supabase, isbn);
  if (existing && (existing.storage_path || isFreshNegative(existing, now))) {
    return { cached: true, rateLimited: false, row: existing };
  }

  // Per-ISBN mutex (audit #12): two concurrent resolves of the same ISBN
  // (two tabs, tab + cron, two cron runs across overlapping cadences)
  // would otherwise each fire full upstream pipelines and burn per-source
  // rate-limit tokens for naught — `persistCover` dedups identical bytes
  // post-fetch but the upstream calls already happened. Lock check sits
  // AFTER the cache guards (no point coordinating cached hits) and BEFORE
  // the per-source `tryAcquire` (loser must not consume per-source budget
  // either). Loser short-circuits with `rateLimited: true` so callers
  // (API handler, page loader, cron) treat it identically to "skip this
  // round" — same external semantics as the existing per-source deny path.
  const lockKey = `catalog:lock:isbn:${isbn}`;
  const acquired = await mutex.acquire(lockKey);
  if (!acquired) {
    return { cached: false, rateLimited: true, row: existing ?? { isbn } };
  }

  try {
    const olOk = await tryAcquire(deps.rateLimiters.openLibrary);
    if (!olOk) {
      return { cached: false, rateLimited: true, row: existing ?? { isbn } };
    }

    // 1. Open Library data + work — metadata only
    const { olData, olWork } = await loadOpenLibraryData(isbn, deps);
    const metadata: CatalogMetadata = extractOpenLibraryMetadata(
      olData,
      olWork,
    );

    // 2. Discover OL cover_id for the chain's OL fallback
    const openLibraryCoverId = await discoverOpenLibraryCoverId(
      olData,
      isbn,
      metadata,
      deps,
    );

    // Memoized GB volume fetcher shared by cover chain + description path
    // (issue #203). Caches only on successful fetch — a rate-limit denial
    // or upstream error leaves the slot open for a retry from the next
    // consumer (e.g. cover chain denied, description still wants to try).
    const fetchGbVolume = memoizeGoogleBooksVolume(deps, () =>
      fetchGoogleBooksByIsbn(isbn, {
        fetchFn: deps.fetchFn,
        apiKey: deps.googleBooksApiKey,
      }),
    );

    // 3. Resolve cover via chain (GB extraLarge → iTunes → OL)
    const cover = await resolveCoverWithTiering(deps, {
      isbn,
      openLibraryCoverId: openLibraryCoverId ?? undefined,
      fetchGbVolume,
    });

    // 4. Description fallback via GB (cover is decoupled from description now)
    await enrichDescriptionWithGoogleBooks(metadata, fetchGbVolume, {
      do_not_refetch_description: existing?.do_not_refetch_description ?? false,
      logCtx: { isbn },
    });

    // 5. Persist cover bytes (with byte-level dedup)
    const storage = await persistCover(
      supabase,
      cover ? { bytes: cover.bytes, mime: cover.mime } : null,
      upload,
    );

    // 6. Build upsert payload + write
    const upsertRow = {
      isbn,
      storage_path: storage?.storage_path ?? null,
      cover_storage_backend: storage?.backend ?? null,
      image_sha256: storage?.image_sha256 ?? null,
      cover_source: cover?.source ?? null,
      cover_max_width: cover?.width ?? null,
      openlibrary_cover_id:
        cover?.openLibraryCoverId ?? metadata.openlibrary_cover_id ?? null,
      google_volume_id:
        cover?.googleVolumeId ?? metadata.google_volume_id ?? null,
      source_url: metadata.source_url ?? null,
      title: metadata.title ?? null,
      author: metadata.author ?? null,
      description: metadata.description ?? null,
      description_raw: metadata.description_raw ?? null,
      description_provider: metadata.description_provider ?? null,
      published_date: metadata.published_date ?? null,
      publisher: metadata.publisher ?? null,
      page_count: metadata.page_count ?? null,
      language: metadata.language ?? null,
      subjects: metadata.subjects ?? null,
      series_name: metadata.series_name ?? null,
      series_position: metadata.series_position ?? null,
      isbn_10: metadata.isbn_10 ?? null,
      fetched_at: storage
        ? now.toISOString()
        : (existing?.fetched_at ?? now.toISOString()),
      last_attempted_at: now.toISOString(),
      attempt_count: (existing?.attempt_count ?? 0) + 1,
    };

    // Partial unique index requires `INSERT ... ON CONFLICT (col) WHERE pred`.
    // supabase-js .upsert() does not pass the WHERE through; route via RPC.
    const { error } = await supabase.rpc("upsert_book_catalog_by_isbn", {
      p_row: upsertRow,
    });
    if (error) throw new Error(`book_catalog upsert: ${error.message}`);

    return { cached: false, rateLimited: false, row: upsertRow };
  } finally {
    await mutex.release(lockKey);
  }
}

export class InvalidTitleAuthorError extends Error {
  constructor() {
    super("InvalidTitleAuthor");
  }
}

export async function resolveTitleAuthor(
  supabase: SupabaseClient,
  title: string,
  author: string,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  const key = normalizeTitleAuthor(title, author);
  if (!key) throw new InvalidTitleAuthorError();
  const now = (deps.now ?? (() => new Date()))();
  const upload = deps.coverStorage?.uploadCover ?? defaultUploadCover;
  const mutex = deps.mutex ?? noopMutex;

  const { data: existingRaw, error: selErr } = await supabase
    .from("book_catalog")
    .select("*")
    .is("isbn", null)
    .eq("normalized_title_author", key)
    .maybeSingle();
  if (selErr) throw new Error(`book_catalog select: ${selErr.message}`);

  const existing = existingRaw as Partial<BookCatalogRowFields> | null;
  if (existing && (existing.storage_path || isFreshNegative(existing, now))) {
    return { cached: true, rateLimited: false, row: existing };
  }

  // Per-(title,author) mutex. Distinct namespace from `isbn:` so an
  // ISBN-keyed and a title/author-keyed lock for the same physical book
  // do NOT collide — they're independently resolved (different DB rows,
  // different upstream queries). See `resolveIsbn` for the full design
  // rationale.
  const lockKey = `catalog:lock:ta:${key}`;
  const acquired = await mutex.acquire(lockKey);
  if (!acquired) {
    return {
      cached: false,
      rateLimited: true,
      row: existing ?? { normalized_title_author: key },
    };
  }

  try {
    const olOk = await tryAcquire(deps.rateLimiters.openLibrary);
    if (!olOk) {
      return {
        cached: false,
        rateLimited: true,
        row: existing ?? { normalized_title_author: key },
      };
    }

    // 1. OL search by title/author — metadata source
    let search: Awaited<ReturnType<typeof searchOpenLibraryByTitleAuthor>> =
      null;
    try {
      search = await searchOpenLibraryByTitleAuthor(title, author, {
        fetchFn: deps.fetchFn,
      });
    } catch (err) {
      logger().warn(
        {
          event: "catalog_openlibrary_search_failed",
          title,
          author,
          error: String(err),
        },
        "catalog_openlibrary_search_failed",
      );
    }

    const metadata: CatalogMetadata = {};
    if (search?.title) metadata.title = search.title;
    if (search?.author_name?.length)
      metadata.author = search.author_name.join(", ");

    // Memoized GB volume fetcher (issue #203) — see resolveIsbn for design.
    const fetchGbVolume = memoizeGoogleBooksVolume(deps, () =>
      fetchGoogleBooksByTitleAuthor(title, author, {
        fetchFn: deps.fetchFn,
        apiKey: deps.googleBooksApiKey,
      }),
    );

    // 2. Resolve cover via chain (title/author flow has no ISBN → no iTunes;
    //    chain falls through to OL via search.cover_i)
    const cover = await resolveCoverWithTiering(deps, {
      title,
      author,
      openLibraryCoverId: search?.cover_i ?? undefined,
      fetchGbVolume,
    });

    // 3. Description fallback via GB
    await enrichDescriptionWithGoogleBooks(metadata, fetchGbVolume, {
      do_not_refetch_description: existing?.do_not_refetch_description ?? false,
      logCtx: { title, author },
    });

    // 4. Persist cover bytes (with byte-level dedup)
    const storage = await persistCover(
      supabase,
      cover ? { bytes: cover.bytes, mime: cover.mime } : null,
      upload,
    );

    // 5. Build upsert payload + write
    const upsertRow = {
      isbn: null as string | null,
      normalized_title_author: key,
      storage_path: storage?.storage_path ?? null,
      cover_storage_backend: storage?.backend ?? null,
      image_sha256: storage?.image_sha256 ?? null,
      cover_source: cover?.source ?? null,
      cover_max_width: cover?.width ?? null,
      title: metadata.title ?? null,
      author: metadata.author ?? null,
      description: metadata.description ?? null,
      description_raw: metadata.description_raw ?? null,
      description_provider: metadata.description_provider ?? null,
      google_volume_id: metadata.google_volume_id ?? null,
      fetched_at: storage
        ? now.toISOString()
        : (existing?.fetched_at ?? now.toISOString()),
      last_attempted_at: now.toISOString(),
      attempt_count: (existing?.attempt_count ?? 0) + 1,
    };

    // Same partial-index reason as resolveIsbn — route via RPC.
    const { error: upErr } = await supabase.rpc(
      "upsert_book_catalog_by_title_author",
      { p_row: upsertRow },
    );
    if (upErr) throw new Error(`book_catalog upsert: ${upErr.message}`);

    return { cached: false, rateLimited: false, row: upsertRow };
  } finally {
    await mutex.release(lockKey);
  }
}
