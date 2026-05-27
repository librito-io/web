import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/sveltekit";
import type { LimitResult, RateLimiter } from "$lib/server/ratelimit";
import { canonicalizeIsbn } from "./isbn";
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
import { extractOpenLibraryMetadata } from "./extract";
import { normalizeTitleAuthor } from "./title-author";
import {
  hasCoverStorage,
  TRACKED_FIELDS,
  type BookCatalogRowFields,
  type CatalogMetadata,
  type CoverSource,
  type CoverStorageBackend,
  type FailReason,
  type FieldProvider,
  type GoogleBooksItem,
  type OpenLibraryDataDoc,
  type OpenLibraryWork,
  type ResolveCtx,
  type TrackedField,
} from "./types";
import {
  shouldAttempt,
  walkChain,
  type ChainResult,
  type FetchOutcome,
} from "./chain";
import {
  classifyDescriptionFromGoogleBooks,
  classifyDescriptionFromItunes,
  classifyDescriptionFromOpenLibrary,
  classifyPageCountFromGoogleBooks,
  classifyPageCountFromOpenLibrary,
  classifyPublishedDateFromGoogleBooks,
  classifyPublishedDateFromOpenLibrary,
  classifyPublisherFromGoogleBooks,
  classifyPublisherFromOpenLibrary,
  classifySubjectsFromGoogleBooks,
  classifySubjectsFromOpenLibrary,
  type GbState,
} from "./field-legs";
import { uploadCover as defaultUploadCover } from "$lib/server/cover-storage";
import { sha256Hex } from "./sha";
import { type CatalogMutex, noopMutex } from "./mutex";
import { logger } from "$lib/server/log";
import { fetchItunesByIsbn, fetchItunesCoverBytes } from "./itunes";
import { decodeImageDimensions } from "./dimensions";

// Canonical shape of an OpenLibrary work ID — e.g. OL12345W. Used as a
// defense-in-depth guard before interpolating the ID into a fetch URL.
// Mirrors the `SHA256_RE` precedent in `src/lib/server/transfer.ts`.
const OL_WORK_ID_RE = /^OL\d+W$/;

export class InvalidIsbnError extends Error {
  constructor(raw: string) {
    super(`InvalidIsbn: ${raw}`);
  }
}

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

function currentTime(deps: Pick<ResolveDeps, "now">): Date {
  return deps.now ? deps.now() : new Date();
}

type CoverBytes = { bytes: Uint8Array; mime: string };
type StorageRecord = {
  storage_path: string;
  backend: CoverStorageBackend;
  image_sha256: string;
};

// Tightest projection that covers every field this file reads off the
// existing row. Hot path — runs on every viewer first-render via
// runInBackground — so `select("*")` drags `description_raw` / `subjects` /
// `description` over the wire on every cache-hit check for nothing.
// ResolveResult.row is returned to callers but none of them read `.row`,
// so widening this list requires a new in-file consumer.
// Selects every column the per-field cache guard + per-field walker
// finalize step reads off the existing row. Hot path on every viewer
// first-render, so we still avoid `select("*")` — but the per-field state
// model needs all 6 value columns + 22 state columns to drive shouldAttempt
// and increment *_attempts. Refit 2026-05-27.
const RESOLVE_SELECT = [
  "pending_storage",
  "storage_path",
  "cover_storage_backend",
  "last_attempted_at",
  "attempt_count",
  "do_not_refetch_description",
  // value columns for shouldAttempt populated-check
  "description",
  "publisher",
  "published_date",
  "subjects",
  "page_count",
  // state columns for shouldAttempt TTL ladder + applyFieldResult increment
  "cover_attempted_at",
  "cover_fail_reason",
  "cover_attempts",
  "description_attempted_at",
  "description_fail_reason",
  "description_attempts",
  "publisher_attempted_at",
  "publisher_fail_reason",
  "publisher_attempts",
  "publisher_provider",
  "published_date_attempted_at",
  "published_date_fail_reason",
  "published_date_attempts",
  "published_date_provider",
  "subjects_attempted_at",
  "subjects_fail_reason",
  "subjects_attempts",
  "subjects_provider",
  "page_count_attempted_at",
  "page_count_fail_reason",
  "page_count_attempts",
  "page_count_provider",
].join(", ");

async function selectByIsbn(
  supabase: SupabaseClient,
  isbn: string,
): Promise<Partial<BookCatalogRowFields> | null> {
  const { data, error } = await supabase
    .from("book_catalog")
    .select(RESOLVE_SELECT)
    .eq("isbn", isbn)
    .maybeSingle();
  if (error) throw new Error(`book_catalog select: ${error.message}`);
  // Two-step `as unknown as` so the literal-union refinement on
  // `cover_storage_backend` is explicit at the cast site (view.ts pattern).
  return (data as unknown as Partial<BookCatalogRowFields> | null) ?? null;
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

// Cover isn't a walker field — derive its fail_reason from the cover
// result + the gb memo outcome the cover chain consulted. Shared by
// resolveIsbn and resolveTitleAuthor so a future bucket addition (e.g.
// "disabled") lands in one place. Returns null when no attempt was made
// (shouldAttempt was false) OR when the cover succeeded — caller writes
// null fail_reason in both cases.
function coverFailReasonFromGb(
  coverShouldAttempt: boolean,
  cover: CoverResolution | null,
  gbOutcome: FetchOutcome<GoogleBooksItem> | null,
): FailReason | null {
  if (!coverShouldAttempt || cover) return null;
  if (gbOutcome?.kind === "rate_limited") return "rate_limited";
  if (gbOutcome?.kind === "transient") return "transient_error";
  return "exhausted";
}

// Description-side iTunes lookup. Distinct from the cover chain's iTunes
// fetch — they each burn their own iTunes token per resolve. Memoization
// across both is deferred (follow-up: separate issue for the deeper
// refactor). Worst case under PR2: cover chain consumes up to 3 iTunes
// tokens (one per tier pass), description leg consumes 1 = 4/resolve.
// iTunes per-day budget is generous; acceptable pre-launch.
async function fetchItunesDescription(
  isbn: string,
  deps: ResolveDeps,
): Promise<FetchOutcome<import("./itunes").ItunesResult>> {
  if (!(await tryAcquire(deps.rateLimiters.itunes))) {
    return { kind: "rate_limited" };
  }
  try {
    const result = await fetchItunesByIsbn(isbn, { fetchFn: deps.fetchFn });
    if (!result) return { kind: "empty" };
    return { kind: "ok", value: result };
  } catch (err) {
    return { kind: "transient", error: err };
  }
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
 * Side-effect: when `fetch` runs, it consumes one GB rate-limit token via
 * `tryAcquire`. Subsequent calls within the same resolve hit the memo
 * (zero additional tokens) once a fetch has succeeded.
 *
 * `snapshot` returns the cached volume WITHOUT triggering a fetch.
 * Returns null if the memo hasn't been populated yet (no consumer has
 * called `fetch`, or all `fetch` calls failed / were rate-limit denied).
 * Used by audit-field capture (plan 2026-05-18 Task 9): we want to record
 * GB metadata regardless of which source wins, but we don't want to burn
 * a fresh GB token just for audit if no cover/description path triggered
 * a fetch.
 */
function memoizeGoogleBooksVolume(
  deps: ResolveDeps,
  fetcher: () => Promise<GoogleBooksItem | null>,
): {
  fetch: () => Promise<GoogleBooksItem | null>;
  snapshot: () => GoogleBooksItem | null;
  /**
   * Last attempt's outcome. Null until `fetch()` has been called once. The
   * walker's GB legs read this to distinguish rate_limited / transient /
   * empty / ok — collapsing all four into `null` via `snapshot()` alone
   * would lose the signal that drives the per-field TTL ladder.
   * Refit 2026-05-27.
   */
  outcome: () => FetchOutcome<GoogleBooksItem> | null;
} {
  let cached: GoogleBooksItem | null = null;
  let last: FetchOutcome<GoogleBooksItem> | null = null;
  return {
    fetch: async () => {
      if (cached) return cached;
      if (!(await tryAcquire(deps.rateLimiters.googleBooks))) {
        last = { kind: "rate_limited" };
        return null;
      }
      try {
        const v = await fetcher();
        if (v) {
          cached = v;
          last = { kind: "ok", value: v };
        } else {
          last = { kind: "empty" };
        }
        return v;
      } catch (err) {
        // Per-leg GB fetch fail → fall through to next consumer / source.
        last = { kind: "transient", error: err };
        return null;
      }
    },
    snapshot: () => cached,
    outcome: () => last,
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
// variant fallback in cover-storage.ts). Salvage tier = native thumbnail
// only; xlarge / large / medium all upscale via resolveVariant fallback
// (cover-storage.ts already downgrades requested variants to the largest
// natively-supported one).
//
// Salvage tier matches the feed-card render target (240×360 actual pixels)
// — books with only thumbnail-grade upstream sources render fuzzy but
// distinguishable, strictly better than the placeholder. GB
// `pdf.isAvailable=false` filter stays tight at salvage tier (issue #209
// anti-wrong-bytes — a small wrong cover renders fuzzy AND wrong, worse
// than no cover). Refit 2026-05-27.
const FLOOR_PREMIUM = 1200;
const FLOOR_BASIC = 300;
const FLOOR_SALVAGE = 240;

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

/** Audit metadata captured per resolve, regardless of which source won.
 *  See plan 2026-05-18 Task 9. */
export interface ResolveAuditFields {
  gb_pdf_available: boolean | null;
  gb_viewability: string | null;
  gb_image_link_tiers: string[] | null;
  cover_aspect: number | null;
  cover_bytes_per_pixel: number | null;
}

function gbAuditFromVolume(
  gb: GoogleBooksItem | null,
): Pick<
  ResolveAuditFields,
  "gb_pdf_available" | "gb_viewability" | "gb_image_link_tiers"
> {
  if (!gb) {
    return {
      gb_pdf_available: null,
      gb_viewability: null,
      gb_image_link_tiers: null,
    };
  }
  const tiers = gb.volumeInfo?.imageLinks
    ? Object.keys(gb.volumeInfo.imageLinks)
    : null;
  return {
    gb_pdf_available:
      typeof gb.accessInfo?.pdf?.isAvailable === "boolean"
        ? gb.accessInfo.pdf.isAvailable
        : null,
    gb_viewability: gb.accessInfo?.viewability ?? null,
    gb_image_link_tiers: tiers,
  };
}

/**
 * Decimal places for `cover_aspect` (height/width ratio). Three places
 * ≈ 0.1% resolution, sufficient for aspect classification. Matches the
 * `NUMERIC(5,3)` column precision in book_catalog.
 */
const COVER_ASPECT_PRECISION = 3;

/**
 * Decimal places for `cover_bytes_per_pixel`. Five places needed for
 * sub-0.001 compressed densities (e.g. 0.11843 bytes/px for a 1500×2250
 * JPEG at 400 KB). Matches the `NUMERIC(7,5)` column precision in
 * book_catalog.
 */
const COVER_BPP_PRECISION = 5;

/**
 * Bytes-per-pixel below this threshold flags a Sentry warning. Real
 * covers have full-bleed art and compress to roughly 0.1–0.4 bytes/px
 * at JPEG quality 80. Interior pages dominated by whitespace compress
 * harder (~0.02–0.08 bpp). Threshold intentionally generous to keep
 * Sentry noise low while still catching the obvious whitespace-template
 * class. Tune based on production `cover_bytes_per_pixel` distribution
 * once weeks of history exist.
 */
const COVER_LOW_BPP_THRESHOLD = 0.05;

/**
 * Compute the five `book_catalog` audit fields from the captured GB
 * volume snapshot and the winning cover (or null when no source won).
 * Centralises the precision quantisation so `resolveIsbn` and
 * `resolveTitleAuthor` share one implementation.
 */
function computeAuditFields(
  gbVolume: GoogleBooksItem | null,
  cover: CoverResolution | null,
): ResolveAuditFields {
  const gbAudit = gbAuditFromVolume(gbVolume);
  if (!cover) {
    return {
      ...gbAudit,
      cover_aspect: null,
      cover_bytes_per_pixel: null,
    };
  }
  return {
    ...gbAudit,
    cover_aspect: Number(
      (cover.height / cover.width).toFixed(COVER_ASPECT_PRECISION),
    ),
    cover_bytes_per_pixel: Number(
      (cover.byteCount / (cover.width * cover.height)).toFixed(
        COVER_BPP_PRECISION,
      ),
    ),
  };
}

export interface CoverResolution {
  bytes: Uint8Array;
  mime: string;
  source: CoverSource;
  width: number;
  height: number;
  byteCount: number;
  /** Volume / cover identifiers to record alongside source (where available). */
  googleVolumeId?: string;
  openLibraryCoverId?: number;
}

/**
 * Emit a Sentry warning when an accepted GoogleBooks cover has
 * bytes-per-pixel below COVER_LOW_BPP_THRESHOLD — the false-negative
 * signal for the pdf.isAvailable filter (Task 8). Caller passes the
 * identifying extras (e.g. `{ isbn }` or `{ normalizedTitleAuthor }`)
 * so the same payload shape works from either resolver entry point.
 *
 * Awaits Sentry.flush(2000) because the surrounding `runInBackground`
 * (Vercel waitUntil) only flushes on the .catch path; without an
 * explicit flush here, success-path warnings would be dropped at
 * function suspension. See memory note vercel-waituntil-flush-async-
 * transports.
 *
 * No-op when the SDK is not initialised (self-hoster path).
 */
async function reportSuspectLowBpp(
  cover: CoverResolution | null,
  audit: ResolveAuditFields,
  identifier: Record<string, string | undefined>,
): Promise<void> {
  if (
    !cover ||
    cover.source !== "google_books" ||
    audit.cover_bytes_per_pixel === null ||
    audit.cover_bytes_per_pixel >= COVER_LOW_BPP_THRESHOLD
  ) {
    return;
  }
  Sentry.captureMessage("catalog_cover_suspect_low_bpp", {
    level: "warning",
    tags: { catalog_audit: "suspect_cover" },
    extra: {
      ...identifier,
      volumeId: cover.googleVolumeId,
      width: cover.width,
      height: cover.height,
      byteCount: cover.byteCount,
      cover_bytes_per_pixel: audit.cover_bytes_per_pixel,
      cover_aspect: audit.cover_aspect,
      viewability: audit.gb_viewability,
    },
  });
  await Sentry.flush(2000);
}

/**
 * Shared tail for the OL / iTunes `try*` chain helpers: fetch bytes
 * via a caller-supplied thunk, decode dimensions, build a
 * `CoverResolution`. Each helper supplies its upstream-specific
 * prelude (rate-limit gating, lookup, etc.) and hands
 * `decodeCoverBytes` the actual byte-fetch thunk.
 *
 * Returns null on any failure path — upstream throw, undersized bytes
 * (the inner fetcher returns null), dimension decode miss. Caller
 * treats null as "no cover from this tier" and falls through to the
 * next chain entry.
 *
 * Centralises `CoverResolution` construction so future shape changes
 * edit one place rather than three.
 *
 * `tryGoogleBooksExtraLarge` intentionally does NOT use this helper:
 * the GB placeholder-sha check (issue #207) sits between bytes-fetch
 * and dimension-decode and does not generalise to non-GB sources.
 */
async function decodeCoverBytes(
  source: CoverSource,
  fetcher: () => Promise<{ bytes: Uint8Array; mime: string } | null>,
  extras: Pick<CoverResolution, "googleVolumeId" | "openLibraryCoverId"> = {},
): Promise<CoverResolution | null> {
  let bytes: { bytes: Uint8Array; mime: string } | null;
  try {
    bytes = await fetcher();
  } catch {
    // Per-source cover-bytes fetch fail → fall through to next source in chain.
    return null;
  }
  if (!bytes) return null;
  const dims = decodeImageDimensions(bytes.bytes);
  if (!dims) return null;
  return {
    bytes: bytes.bytes,
    mime: bytes.mime,
    source,
    width: dims.width,
    height: dims.height,
    byteCount: bytes.bytes.length,
    ...extras,
  };
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

  // Discriminator: GB serves real cover bytes when the volume has a
  // backing PDF in their system (first-page scan or publisher-supplied
  // cover). Without one, the imageLinks bytes are publisher InDesign
  // template / interior-page artifacts cached during catalog ingestion.
  // See issue #209 (revised mechanism) + 2026-05-18 n=9 study.
  //
  // Empirically splits the bad cohort (Apple in China, Annie Bot, others
  // in PR #208 backfill) from the good cohort 9/9. Validation runs in
  // production via the gb_pdf_available audit column (Task 9).
  //
  // Trade-off accepted: some legitimate older / public-domain / out-of-
  // print books may have pdf.isAvailable=false AND real covers. They'll
  // fall through to OL ISBN-direct (Task 6) or iTunes. Sentry warning on
  // suspect accepted covers (Task 10) flags the inverse — anything that
  // passes the filter but still looks wrong.
  const pdfAvailable = gb.accessInfo?.pdf?.isAvailable === true;
  if (!pdfAvailable) {
    logger().warn(
      {
        event: "catalog_gb_rejected_no_pdf",
        isbn: ctx.isbn,
        volumeId: gb.id,
        viewability: gb.accessInfo?.viewability,
        imageLinkTiers: Object.keys(gb.volumeInfo.imageLinks),
      },
      "catalog_gb_rejected_no_pdf",
    );
    return null;
  }

  const link = selectBestGoogleImageLink(gb.volumeInfo.imageLinks);
  if (!link) return null;
  let bytes: { bytes: Uint8Array; mime: string } | null;
  try {
    bytes = await fetchGoogleBooksCoverBytes(link, {
      fetchFn: deps.fetchFn,
      minWidth,
    });
  } catch {
    // GB cover-bytes fetch fail → fall through to next source in chain.
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
    height: dims.height,
    byteCount: bytes.bytes.length,
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
    // iTunes ISBN lookup fail → fall through to next source in chain.
    return null;
  }
  const artworkUrl = lookup?.artworkUrl100;
  if (!artworkUrl) return null;
  return decodeCoverBytes("itunes", () =>
    fetchItunesCoverBytes(artworkUrl, {
      fetchFn: deps.fetchFn,
      minWidth,
    }),
  );
}

async function tryOpenLibrary(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  if (!ctx.openLibraryCoverId) return null;
  return decodeCoverBytes(
    ctx.isbn ? "openlibrary_isbn" : "openlibrary_search_title",
    () =>
      fetchOpenLibraryCoverBytes(ctx.openLibraryCoverId!, {
        fetchFn: deps.fetchFn,
        minWidth,
      }),
    { openLibraryCoverId: ctx.openLibraryCoverId },
  );
}

async function tryOpenLibraryDirectIsbn(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  // Title/author flow has no ISBN — this tier auto-skips there.
  if (!ctx.isbn) return null;
  return decodeCoverBytes("openlibrary_isbn_direct", () =>
    fetchOpenLibraryCoverBytesByIsbn(ctx.isbn!, {
      fetchFn: deps.fetchFn,
      minWidth,
    }),
  );
}

/** Walk sources in precision-first priority order; each source has the same
 *  `minWidth` floor applied. First source whose decoded width meets `minWidth`
 *  wins. Null when all sources fail.
 *
 *  Order (issue #211, plan 2026-05-18):
 *    1. OL direct-ISBN (covers/b/isbn/{isbn}-L): ISBN-locked, OL-resolved
 *       across editions of the Work.
 *    2. OL cover_id (covers/b/id/{cover_id}-L): requires explicit cover_id
 *       discovery via /api/books or /search.json.
 *    3. GoogleBooks extraLarge: resolution-rich but prone to wrong-bytes
 *       failure mode (limited-preview volumes serve InDesign interior
 *       pages). Filtered by accessInfo.pdf.isAvailable in Task 8.
 *    4. iTunes: ISBN-keyed, generally precise but lower resolution.
 *
 *  Trade-off: prefers precision over resolution. Some books where OL has
 *  only basic-tier coverage but GB has premium will now stop at OL basic.
 *  Second-pass (basic floor) preserves the same ordering. */
async function resolveCoverChain(
  deps: ResolveDeps,
  ctx: CoverChainContext,
  minWidth: number,
): Promise<CoverResolution | null> {
  return (
    (await tryOpenLibraryDirectIsbn(deps, ctx, minWidth)) ??
    (await tryOpenLibrary(deps, ctx, minWidth)) ??
    (await tryGoogleBooksExtraLarge(deps, ctx, minWidth)) ??
    (await tryItunes(deps, ctx, minWidth))
  );
}

/** Three-pass tiering: premium (1200) → basic (300) → salvage (240).
 *
 * Worst-case budget per ISBN: 12 upstream cover attempts (4 sources × 3
 * passes). Per-source token consumption unchanged:
 *   - OL: 1 token total. Acquired once in resolveIsbn/resolveTitleAuthor
 *     before the chain enters; shared by every OL tier across all passes.
 *   - GB: 1 token total. Memoized by memoizeGoogleBooksVolume; only the
 *     first call to fetchGbVolume consumes a token across cover + walker
 *     consumers.
 *   - iTunes: up to 3 tokens (one per pass that reaches the iTunes leg).
 *     Cover-side only — the walker's iTunes description leg has its own
 *     separate token budget (see fetchItunesDescription).
 * Worst-case cover budget: 1 + 1 + 3 = 5 tokens per ISBN.
 *
 * Salvage tier accepts down to 240 px — matches the feed-card render
 * target (240×360 actual pixels). Books where the upstream best is
 * thumbnail-grade (250-299 px) now resolve to a soft-but-distinguishable
 * cover instead of the placeholder. GB `pdf.isAvailable=false` filter
 * applies at all three tiers (issue #209 anti-wrong-bytes mechanism
 * preserved at every tier — not anti-low-res). Refit 2026-05-27. */
async function resolveCoverWithTiering(
  deps: ResolveDeps,
  ctx: CoverChainContext,
): Promise<CoverResolution | null> {
  return (
    (await resolveCoverChain(deps, ctx, FLOOR_PREMIUM)) ??
    (await resolveCoverChain(deps, ctx, FLOOR_BASIC)) ??
    (await resolveCoverChain(deps, ctx, FLOOR_SALVAGE))
  );
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
  // OL work IDs are interpolated into the work-fetch URL; while the host is
  // fixed to openlibrary.org today, validating the shape at the boundary keeps
  // the pattern safe under a future host-configurable / self-host refactor
  // (issue #253). See `OL_WORK_ID_RE` at module top.
  if (id && OL_WORK_ID_RE.test(id)) {
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
  ctx?: ResolveCtx,
): Promise<ResolveResult> {
  const isbn = canonicalizeIsbn(rawIsbn);
  if (!isbn) throw new InvalidIsbnError(rawIsbn);

  const now = currentTime(deps);
  const upload = deps.coverStorage?.uploadCover ?? defaultUploadCover;
  const mutex = deps.mutex ?? noopMutex;

  const existing = await selectByIsbn(supabase, isbn);
  // Cache short-circuit replaced by per-field gating (refit 2026-05-27).
  // Row is "cached" only when every tracked field is populated OR within
  // its fail_reason TTL window. pending_storage=TRUE always falls through
  // so the upload + finalize retry path runs (spec 2026-05-18).
  if (
    existing &&
    !existing.pending_storage &&
    TRACKED_FIELDS.every((f) => !shouldAttempt(f, existing, now))
  ) {
    return { cached: true, rateLimited: false, row: existing };
  }

  // Per-ISBN mutex (audit #12): two concurrent resolves of the same ISBN
  // (two tabs, tab + cron, two cron runs across overlapping cadences)
  // would otherwise each fire full upstream pipelines and burn per-source
  // rate-limit tokens for naught. Loser short-circuits with `rateLimited:
  // true` and consumes neither per-source budget nor *_attempts. See
  // existing rationale in selectByIsbn comments + spec.
  const lockKey = `catalog:lock:isbn:${isbn}`;
  const acquired = await mutex.acquire(lockKey);
  if (!acquired) {
    return { cached: false, rateLimited: true, row: existing ?? { isbn } };
  }

  try {
    const olOk = await tryAcquire(deps.rateLimiters.openLibrary);
    if (!olOk) {
      // Pre-acquire OL denial: leave per-field state UNCHANGED so
      // shouldAttempt fires again on the next pass via the
      // null-attempted-at branch (or its existing TTL). No UPDATE here.
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

    // Memoized GB volume fetcher shared by cover chain + walker GB legs
    // (issue #203 + refit 2026-05-27). Caches only on successful fetch;
    // outcome() exposes the last attempt for walker leg classification.
    const gbMemo = memoizeGoogleBooksVolume(deps, () =>
      fetchGoogleBooksByIsbn(isbn, {
        fetchFn: deps.fetchFn,
        apiKey: deps.googleBooksApiKey,
      }),
    );

    // 3. Cover chain (existing 3-tier resolveCoverWithTiering). Only walks
    //    when shouldAttempt('cover'); otherwise skip the expensive byte
    //    fetch entirely. Per-field gating extends to cover.
    const coverShouldAttempt = shouldAttempt("cover", existing ?? {}, now);
    const cover = coverShouldAttempt
      ? await resolveCoverWithTiering(deps, {
          isbn,
          openLibraryCoverId: openLibraryCoverId ?? undefined,
          fetchGbVolume: gbMemo.fetch,
        })
      : null;

    // 4. Prime GB memo ONCE for the walker's GB legs when any non-cover
    //    field needs walking AND cover chain didn't already trigger GB.
    //    One GB token per resolve regardless of how many GB legs fire.
    const nonCoverNeedsWalk = TRACKED_FIELDS.some(
      (f) => f !== "cover" && shouldAttempt(f, existing ?? {}, now),
    );
    if (
      nonCoverNeedsWalk &&
      gbMemo.outcome() === null &&
      deps.googleBooksApiKey
    ) {
      await gbMemo.fetch();
    }

    // 5. Build GbState for walker legs.
    const gbState: GbState = !deps.googleBooksApiKey
      ? { apiKeySet: false }
      : {
          apiKeySet: true,
          outcome: gbMemo.outcome() ?? { kind: "empty" },
        };

    // 6. Walk each non-cover tracked field whose TTL is up.
    const walkerCtx: ResolveCtx = ctx ?? {};
    const fieldResults: Partial<Record<TrackedField, ChainResult<unknown>>> =
      {};

    if (shouldAttempt("description", existing ?? {}, now)) {
      const doNotRefetch = existing?.do_not_refetch_description ?? false;
      if (doNotRefetch) {
        // Takedown flag preserved. Walker skipped — but state IS written
        // so the 90-day exhausted TTL gates re-attempts and viewer-load
        // log spam is bounded to one per quarter, not every render.
        // catalog_description_skipped_takedown_flag warn surfaces the
        // first carryover per resolve so audit can spot a stale flag
        // (issue #206).
        logger().warn(
          { event: "catalog_description_skipped_takedown_flag", isbn },
          "catalog_description_skipped_takedown_flag",
        );
        fieldResults.description = {
          value: null,
          provider: null,
          fail_reason: "exhausted",
        };
      } else {
        fieldResults.description = await walkChain<string>(
          {
            field: "description",
            legs: [
              async () => classifyDescriptionFromOpenLibrary(olWork),
              async () => classifyDescriptionFromGoogleBooks(gbState),
              async () =>
                classifyDescriptionFromItunes({
                  hasIsbn: true,
                  outcome: await fetchItunesDescription(isbn, deps),
                }),
            ],
          },
          walkerCtx,
        );
      }
    }
    if (shouldAttempt("publisher", existing ?? {}, now)) {
      fieldResults.publisher = await walkChain<string>(
        {
          field: "publisher",
          legs: [
            async () => classifyPublisherFromOpenLibrary(olData),
            async () => classifyPublisherFromGoogleBooks(gbState),
          ],
        },
        walkerCtx,
      );
    }
    if (shouldAttempt("published_date", existing ?? {}, now)) {
      fieldResults.published_date = await walkChain<string>(
        {
          field: "published_date",
          legs: [
            async () => classifyPublishedDateFromOpenLibrary(olData),
            async () => classifyPublishedDateFromGoogleBooks(gbState),
          ],
        },
        walkerCtx,
      );
    }
    if (shouldAttempt("subjects", existing ?? {}, now)) {
      fieldResults.subjects = await walkChain<string[]>(
        {
          field: "subjects",
          legs: [
            async () => classifySubjectsFromOpenLibrary(olData, olWork),
            async () => classifySubjectsFromGoogleBooks(gbState),
          ],
        },
        walkerCtx,
      );
    }
    if (shouldAttempt("page_count", existing ?? {}, now)) {
      fieldResults.page_count = await walkChain<number>(
        {
          field: "page_count",
          legs: [
            async () => classifyPageCountFromOpenLibrary(olData),
            async () => classifyPageCountFromGoogleBooks(gbState),
          ],
        },
        walkerCtx,
      );
    }

    // 7. Capture description_raw from the GB outcome when description was
    //    sourced via GB. The walker's leg returns the cleaned text; the
    //    raw GB description goes into a separate column for debug parity
    //    with the pre-refit enrichment helper.
    if (
      fieldResults.description?.provider === "google_books" &&
      gbMemo.snapshot()?.volumeInfo?.description
    ) {
      metadata.description_raw = gbMemo.snapshot()!.volumeInfo!.description!;
    }
    // GB volume id flows from gbMemo regardless of which leg won the
    // walker — preserves pre-refit behaviour where description fetched
    // from GB carried google_volume_id even when cover came from OL.
    if (gbMemo.snapshot()?.id) {
      metadata.google_volume_id = gbMemo.snapshot()!.id;
    }

    // 8. Cover provider + fail_reason classification.
    const coverFailReason = coverFailReasonFromGb(
      coverShouldAttempt,
      cover,
      gbMemo.outcome(),
    );

    const audit = computeAuditFields(gbMemo.snapshot(), cover);

    // 9. Build pendingRow with per-field value + state writes.
    //
    //    Cover state has two outcome shapes:
    //      - cover === null (negative): write cover_attempted_at +
    //        cover_fail_reason in the upsert. No finalize UPDATE will run.
    //      - cover !== null (positive): leave cover_attempted_at NULL in
    //        the upsert; write it (+ cover_fail_reason = NULL) in the
    //        post-upload finalize UPDATE. Throw between upload and
    //        finalize leaves state NULL → next pass's shouldAttempt
    //        returns true via the never-attempted branch.
    //
    //    Non-cover fields write attempted_at + fail_reason in the upsert
    //    when their walker ran; existing state otherwise preserved via
    //    COALESCE in the upsert RPC. *_attempts is GREATEST-merged.
    const pending = cover !== null;
    const coverStateInUpsert = coverShouldAttempt && cover === null;

    const pendingRow = buildPendingRow({
      isbn,
      normalizedTitleAuthor: null,
      cover,
      coverStateInUpsert,
      coverFailReason,
      metadata,
      existing,
      fieldResults,
      audit,
      pending,
      now,
    });

    const { error: pendingErr } = await supabase.rpc(
      "upsert_book_catalog_by_isbn",
      { p_row: pendingRow },
    );
    if (pendingErr)
      throw new Error(`book_catalog initial upsert: ${pendingErr.message}`);

    // 10. Upload + finalize for positive cover. Writes cover_attempted_at
    //     + cover_fail_reason = NULL alongside storage + clears pending.
    let storage: Awaited<ReturnType<typeof persistCover>> = null;
    if (cover) {
      storage = await persistCover(
        supabase,
        { bytes: cover.bytes, mime: cover.mime },
        upload,
      );
      const { error: finalErr } = await supabase
        .from("book_catalog")
        .update({
          storage_path: storage?.storage_path ?? null,
          cover_storage_backend: storage?.backend ?? null,
          image_sha256: storage?.image_sha256 ?? null,
          cover_max_width: cover.width,
          pending_storage: false,
          cover_attempted_at: now.toISOString(),
          cover_fail_reason: null,
          cover_attempts:
            ((existing?.cover_attempts as number | undefined) ?? 0) + 1,
        })
        .eq("isbn", isbn);
      if (finalErr)
        throw new Error(`book_catalog storage finalize: ${finalErr.message}`);
    }

    await reportSuspectLowBpp(cover, audit, { isbn });

    const resultRow = {
      ...pendingRow,
      storage_path: storage?.storage_path ?? null,
      cover_storage_backend: storage?.backend ?? null,
      image_sha256: storage?.image_sha256 ?? null,
      cover_max_width: cover?.width ?? null,
      pending_storage: false,
    };
    return { cached: false, rateLimited: false, row: resultRow };
  } finally {
    await mutex.release(lockKey);
  }
}

// Composes the upsert payload from cover + walker + audit + metadata.
// Shared by resolveIsbn and resolveTitleAuthor — payload shape is
// identical except for the key columns (isbn vs normalized_title_author).
// Cover state writes follow the dual-shape rule (see resolveIsbn step 9
// comment): when cover === null, attempted_at + fail_reason land here;
// when cover !== null, the finalize UPDATE writes them post-upload.
export interface BuildPendingRowArgs {
  isbn: string | null;
  normalizedTitleAuthor: string | null;
  cover: CoverResolution | null;
  coverStateInUpsert: boolean;
  coverFailReason: FailReason | null;
  metadata: CatalogMetadata;
  existing: Partial<BookCatalogRowFields> | null | undefined;
  fieldResults: Partial<Record<TrackedField, ChainResult<unknown>>>;
  audit: ResolveAuditFields;
  pending: boolean;
  now: Date;
}

export function buildPendingRow(
  args: BuildPendingRowArgs,
): Record<string, unknown> {
  const {
    isbn,
    normalizedTitleAuthor,
    cover,
    coverStateInUpsert,
    coverFailReason,
    metadata,
    existing,
    fieldResults,
    audit,
    pending,
    now,
  } = args;

  const fieldValue = <T>(field: TrackedField): T | null => {
    const r = fieldResults[field];
    return (r?.value as T | null | undefined) ?? null;
  };
  const fieldProvider = (field: TrackedField): FieldProvider | null => {
    const r = fieldResults[field];
    return (r?.provider as FieldProvider | null | undefined) ?? null;
  };
  const stateAttemptedAt = (field: TrackedField): string | null =>
    fieldResults[field] ? now.toISOString() : null;
  const stateFailReason = (field: TrackedField): FailReason | null =>
    fieldResults[field]?.fail_reason ?? null;
  const stateAttempts = (field: TrackedField): number => {
    if (!fieldResults[field]) return 0;
    const prior =
      (existing?.[`${field}_attempts` as keyof BookCatalogRowFields] as
        | number
        | undefined) ?? 0;
    return prior + 1;
  };

  // description column may still have the OL-extracted value when
  // shouldAttempt was false (existing populated row, walker skipped).
  // For walked-description, prefer the walker's result; otherwise leave
  // null so COALESCE preserves any prior value on existing rows.
  const descriptionValue = fieldResults.description
    ? (fieldValue<string>("description") as string | null)
    : null;
  const publisherValue = fieldResults.publisher
    ? (fieldValue<string>("publisher") as string | null)
    : null;
  const publishedDateValue = fieldResults.published_date
    ? (fieldValue<string>("published_date") as string | null)
    : null;
  const pageCountValue = fieldResults.page_count
    ? (fieldValue<number>("page_count") as number | null)
    : null;
  const subjectsValue = fieldResults.subjects
    ? (fieldValue<string[]>("subjects") as string[] | null)
    : null;

  return {
    isbn,
    ...(normalizedTitleAuthor !== null
      ? { normalized_title_author: normalizedTitleAuthor }
      : {}),
    storage_path: null,
    cover_storage_backend: null,
    image_sha256: null,
    cover_source: cover?.source ?? null,
    cover_max_width: null,
    openlibrary_cover_id:
      cover?.openLibraryCoverId ?? metadata.openlibrary_cover_id ?? null,
    google_volume_id:
      cover?.googleVolumeId ?? metadata.google_volume_id ?? null,
    source_url: metadata.source_url ?? null,
    title: metadata.title ?? null,
    author: metadata.author ?? null,
    description: descriptionValue,
    description_raw: metadata.description_raw ?? null,
    description_provider: fieldProvider("description"),
    published_date: publishedDateValue,
    publisher: publisherValue,
    page_count: pageCountValue,
    language: metadata.language ?? null,
    subjects: subjectsValue,
    series_name: metadata.series_name ?? null,
    series_position: metadata.series_position ?? null,
    isbn_10: metadata.isbn_10 ?? null,
    fetched_at: now.toISOString(),
    last_attempted_at: now.toISOString(),
    attempt_count: (existing?.attempt_count ?? 0) + 1,
    gb_pdf_available: audit.gb_pdf_available,
    gb_viewability: audit.gb_viewability,
    gb_image_link_tiers: audit.gb_image_link_tiers,
    cover_aspect: audit.cover_aspect,
    cover_bytes_per_pixel: audit.cover_bytes_per_pixel,
    pending_storage: pending,
    // Per-field state. cover writes here only when cover === null (the
    // negative-cache shape); positive cover state lands in finalize UPDATE.
    cover_attempted_at: coverStateInUpsert ? now.toISOString() : null,
    cover_fail_reason: coverStateInUpsert ? coverFailReason : null,
    cover_attempts: coverStateInUpsert
      ? ((existing?.cover_attempts as number | undefined) ?? 0) + 1
      : 0,
    description_attempted_at: stateAttemptedAt("description"),
    description_fail_reason: stateFailReason("description"),
    description_attempts: stateAttempts("description"),
    publisher_attempted_at: stateAttemptedAt("publisher"),
    publisher_fail_reason: stateFailReason("publisher"),
    publisher_attempts: stateAttempts("publisher"),
    publisher_provider: fieldProvider("publisher"),
    published_date_attempted_at: stateAttemptedAt("published_date"),
    published_date_fail_reason: stateFailReason("published_date"),
    published_date_attempts: stateAttempts("published_date"),
    published_date_provider: fieldProvider("published_date"),
    subjects_attempted_at: stateAttemptedAt("subjects"),
    subjects_fail_reason: stateFailReason("subjects"),
    subjects_attempts: stateAttempts("subjects"),
    subjects_provider: fieldProvider("subjects"),
    page_count_attempted_at: stateAttemptedAt("page_count"),
    page_count_fail_reason: stateFailReason("page_count"),
    page_count_attempts: stateAttempts("page_count"),
    page_count_provider: fieldProvider("page_count"),
  };
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
  const now = currentTime(deps);
  const upload = deps.coverStorage?.uploadCover ?? defaultUploadCover;
  const mutex = deps.mutex ?? noopMutex;

  const { data: existingRaw, error: selErr } = await supabase
    .from("book_catalog")
    .select(RESOLVE_SELECT)
    .is("isbn", null)
    .eq("normalized_title_author", key)
    .maybeSingle();
  if (selErr) throw new Error(`book_catalog select: ${selErr.message}`);

  const existing =
    existingRaw as unknown as Partial<BookCatalogRowFields> | null;
  // Per-field gating short-circuit. Refit 2026-05-27. Matches resolveIsbn
  // logic — see that function's step 1 comment for the rationale.
  if (
    existing &&
    !existing.pending_storage &&
    TRACKED_FIELDS.every((f) => !shouldAttempt(f, existing, now))
  ) {
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

    // 1. OL search by title/author — metadata source. TA path has no
    //    OL data doc or work doc (those are ISBN-keyed); walker OL legs
    //    therefore see olData=null + olWork=null and aggregate to
    //    `no_data`. Only the GB legs can succeed on TA resolves.
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

    // Memoized GB volume fetcher (issue #203 + refit 2026-05-27).
    const gbMemo = memoizeGoogleBooksVolume(deps, () =>
      fetchGoogleBooksByTitleAuthor(title, author, {
        fetchFn: deps.fetchFn,
        apiKey: deps.googleBooksApiKey,
      }),
    );

    // 2. Cover via chain (TA path has no ISBN → no iTunes leg in the
    //    cover chain; falls through to OL via search.cover_i). Gated on
    //    shouldAttempt('cover').
    const coverShouldAttempt = shouldAttempt("cover", existing ?? {}, now);
    const cover = coverShouldAttempt
      ? await resolveCoverWithTiering(deps, {
          title,
          author,
          openLibraryCoverId: search?.cover_i ?? undefined,
          fetchGbVolume: gbMemo.fetch,
        })
      : null;

    // 3. Prime GB memo if any non-cover field needs walking.
    const nonCoverNeedsWalk = TRACKED_FIELDS.some(
      (f) => f !== "cover" && shouldAttempt(f, existing ?? {}, now),
    );
    if (
      nonCoverNeedsWalk &&
      gbMemo.outcome() === null &&
      deps.googleBooksApiKey
    ) {
      await gbMemo.fetch();
    }

    const gbState: GbState = !deps.googleBooksApiKey
      ? { apiKeySet: false }
      : {
          apiKeySet: true,
          outcome: gbMemo.outcome() ?? { kind: "empty" },
        };

    // 4. Walk each non-cover tracked field. iTunes description leg is
    //    disabled on TA path (no ISBN to query by); OL legs see null
    //    upstream and aggregate to no_data.
    const fieldResults: Partial<Record<TrackedField, ChainResult<unknown>>> =
      {};

    if (shouldAttempt("description", existing ?? {}, now)) {
      const doNotRefetch = existing?.do_not_refetch_description ?? false;
      if (doNotRefetch) {
        // See resolveIsbn for the rationale on writing exhausted state.
        logger().warn(
          {
            event: "catalog_description_skipped_takedown_flag",
            title,
            author,
          },
          "catalog_description_skipped_takedown_flag",
        );
        fieldResults.description = {
          value: null,
          provider: null,
          fail_reason: "exhausted",
        };
      } else {
        fieldResults.description = await walkChain<string>(
          {
            field: "description",
            legs: [
              async () => classifyDescriptionFromOpenLibrary(null),
              async () => classifyDescriptionFromGoogleBooks(gbState),
              async () => classifyDescriptionFromItunes({ hasIsbn: false }),
            ],
          },
          {},
        );
      }
    }
    if (shouldAttempt("publisher", existing ?? {}, now)) {
      fieldResults.publisher = await walkChain<string>(
        {
          field: "publisher",
          legs: [
            async () => classifyPublisherFromOpenLibrary(null),
            async () => classifyPublisherFromGoogleBooks(gbState),
          ],
        },
        {},
      );
    }
    if (shouldAttempt("published_date", existing ?? {}, now)) {
      fieldResults.published_date = await walkChain<string>(
        {
          field: "published_date",
          legs: [
            async () => classifyPublishedDateFromOpenLibrary(null),
            async () => classifyPublishedDateFromGoogleBooks(gbState),
          ],
        },
        {},
      );
    }
    if (shouldAttempt("subjects", existing ?? {}, now)) {
      fieldResults.subjects = await walkChain<string[]>(
        {
          field: "subjects",
          legs: [
            async () => classifySubjectsFromOpenLibrary(null, null),
            async () => classifySubjectsFromGoogleBooks(gbState),
          ],
        },
        {},
      );
    }
    if (shouldAttempt("page_count", existing ?? {}, now)) {
      fieldResults.page_count = await walkChain<number>(
        {
          field: "page_count",
          legs: [
            async () => classifyPageCountFromOpenLibrary(null),
            async () => classifyPageCountFromGoogleBooks(gbState),
          ],
        },
        {},
      );
    }

    if (
      fieldResults.description?.provider === "google_books" &&
      gbMemo.snapshot()?.volumeInfo?.description
    ) {
      metadata.description_raw = gbMemo.snapshot()!.volumeInfo!.description!;
    }
    if (gbMemo.snapshot()?.id) {
      metadata.google_volume_id = gbMemo.snapshot()!.id;
    }

    const coverFailReason = coverFailReasonFromGb(
      coverShouldAttempt,
      cover,
      gbMemo.outcome(),
    );

    const audit = computeAuditFields(gbMemo.snapshot(), cover);
    const pending = cover !== null;
    const coverStateInUpsert = coverShouldAttempt && cover === null;

    const pendingRow = buildPendingRow({
      isbn: null,
      normalizedTitleAuthor: key,
      cover,
      coverStateInUpsert,
      coverFailReason,
      metadata,
      existing,
      fieldResults,
      audit,
      pending,
      now,
    });

    const { error: pendingErr } = await supabase.rpc(
      "upsert_book_catalog_by_title_author",
      { p_row: pendingRow },
    );
    if (pendingErr)
      throw new Error(`book_catalog initial upsert: ${pendingErr.message}`);

    let storage: Awaited<ReturnType<typeof persistCover>> = null;
    if (cover) {
      storage = await persistCover(
        supabase,
        { bytes: cover.bytes, mime: cover.mime },
        upload,
      );
      const { error: finalErr } = await supabase
        .from("book_catalog")
        .update({
          storage_path: storage?.storage_path ?? null,
          cover_storage_backend: storage?.backend ?? null,
          image_sha256: storage?.image_sha256 ?? null,
          cover_max_width: cover.width,
          pending_storage: false,
          cover_attempted_at: now.toISOString(),
          cover_fail_reason: null,
          cover_attempts:
            ((existing?.cover_attempts as number | undefined) ?? 0) + 1,
        })
        .is("isbn", null)
        .eq("normalized_title_author", key);
      if (finalErr)
        throw new Error(`book_catalog storage finalize: ${finalErr.message}`);
    }

    await reportSuspectLowBpp(cover, audit, { normalizedTitleAuthor: key });

    const resultRow = {
      ...pendingRow,
      storage_path: storage?.storage_path ?? null,
      cover_storage_backend: storage?.backend ?? null,
      image_sha256: storage?.image_sha256 ?? null,
      cover_max_width: cover?.width ?? null,
      pending_storage: false,
    };
    return { cached: false, rateLimited: false, row: resultRow };
  } finally {
    await mutex.release(lockKey);
  }
}
