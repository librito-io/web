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
} from "./openlibrary";
import {
  fetchGoogleBooksByIsbn,
  fetchGoogleBooksByTitleAuthor,
  fetchGoogleBooksCoverBytes,
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
} from "./types";
import { uploadCover as defaultUploadCover } from "$lib/server/cover-storage";

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
  };
  coverStorage?: { uploadCover: typeof defaultUploadCover };
  googleBooksApiKey?: string;
  now?: () => Date;
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
    const r = (await limiter.limit("catalog")) as LimitResult;
    return r.success;
  } catch {
    return true; // fail-open per limiter policy
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

/**
 * Run the Google Books fallback for description and/or cover.
 *
 * Both resolvers (`resolveIsbn`, `resolveTitleAuthor`) consult Google
 * Books only when the Open Library pass left description or cover bytes
 * unfilled. The shared semantics:
 *
 *   - Per-source rate-limit budget is checked here (fail-open via
 *     `tryAcquire`); helper short-circuits silently if exhausted.
 *   - `do_not_refetch_description` flag gates description text ONLY.
 *     Cover fallback runs regardless — publisher takedowns target
 *     marketing copy, not cover images, so a takedown'd ISBN with no OL
 *     cover must not end up permanently coverless.
 *   - All upstream errors are caught and logged via `console.warn` with
 *     a stable code (`catalog_googlebooks_failed`,
 *     `catalog_googlebooks_cover_failed`). Failures degrade to the
 *     pre-helper state of `metadata` + `coverBytes`.
 *
 * The caller supplies `fetchVolume` (closes over isbn vs title/author),
 * `logCtx` (used in warn payloads), and a mutable `metadata` object.
 * Returns the (possibly updated) cover bytes and source.
 */
async function enrichWithGoogleBooks(
  metadata: CatalogMetadata,
  coverBytes: CoverBytes | null,
  fetchVolume: () => Promise<GoogleBooksItem | null>,
  opts: {
    deps: ResolveDeps;
    do_not_refetch_description: boolean;
    logCtx: Record<string, unknown>;
  },
): Promise<{ coverBytes: CoverBytes | null; coverSource?: CoverSource }> {
  if (metadata.description && coverBytes) {
    return { coverBytes };
  }
  const gbOk = await tryAcquire(opts.deps.rateLimiters.googleBooks);
  if (!gbOk) return { coverBytes };

  let coverSource: CoverSource | undefined;
  try {
    const gb = await fetchVolume();
    if (gb) {
      const gbMeta = extractGoogleBooksMetadata(gb);
      if (
        !metadata.description &&
        gbMeta.description &&
        !opts.do_not_refetch_description
      ) {
        metadata.description_raw = gbMeta.description;
        metadata.description = stripMarketingCruft(gbMeta.description);
        metadata.description_provider = "google_books";
        metadata.google_volume_id = gbMeta.google_volume_id;
      }
      if (!coverBytes) {
        const link =
          gb.volumeInfo?.imageLinks?.large ??
          gb.volumeInfo?.imageLinks?.thumbnail;
        if (link) {
          try {
            coverBytes = await fetchGoogleBooksCoverBytes(link, {
              fetchFn: opts.deps.fetchFn,
            });
          } catch (err) {
            console.warn("catalog_googlebooks_cover_failed", {
              ...opts.logCtx,
              error: String(err),
            });
            coverBytes = null;
          }
          if (coverBytes) coverSource = "google_books";
        }
      }
    }
  } catch (err) {
    console.warn("catalog_googlebooks_failed", {
      ...opts.logCtx,
      error: String(err),
    });
  }
  return { coverBytes, coverSource };
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
  olData: ReturnType<typeof extractOpenLibraryMetadata> extends infer _
    ?
        | (Awaited<ReturnType<typeof fetchOpenLibraryByIsbn>> & {
            cover?: { large?: string };
          })
        | null
    : never;
  olWork: Awaited<ReturnType<typeof fetchOpenLibraryWork>> | null;
}> {
  const olData = (await fetchOpenLibraryByIsbn(isbn, {
    fetchFn: deps.fetchFn,
  })) as
    | (Awaited<ReturnType<typeof fetchOpenLibraryByIsbn>> & {
        cover?: { large?: string };
      })
    | null;
  let olWork: Awaited<ReturnType<typeof fetchOpenLibraryWork>> | null = null;
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

/**
 * Resolve the Open Library cover for an ISBN.
 *
 * First checks the data document's `cover.large` URL for an embedded
 * cover_id. If absent, falls back to the search-by-isbn endpoint which
 * also yields cover_i + title/author hints. Mutates `metadata` with
 * search-derived title/author when found.
 *
 * Returns the resolved coverBytes (if any), the cover source label, and
 * the cover_id used (for upsert payload archival).
 */
async function resolveOpenLibraryCover(
  olData: { cover?: { large?: string } } | null,
  isbn: string,
  metadata: CatalogMetadata,
  deps: ResolveDeps,
): Promise<{
  coverBytes: CoverBytes | null;
  coverSource: CoverSource | undefined;
  coverId: number | undefined;
}> {
  let coverId: number | undefined;
  let coverSource: CoverSource | undefined;

  const coverLargeUrl = olData?.cover?.large;
  if (coverLargeUrl) {
    const match = coverLargeUrl.match(/\/id\/(\d+)-/);
    if (match) coverId = Number(match[1]);
  }
  if (coverId) {
    coverSource = "openlibrary_isbn";
  } else {
    let search: Awaited<ReturnType<typeof searchOpenLibraryByIsbn>> = null;
    try {
      search = await searchOpenLibraryByIsbn(isbn, { fetchFn: deps.fetchFn });
    } catch (err) {
      console.warn("catalog_openlibrary_search_failed", {
        isbn,
        error: String(err),
      });
    }
    if (search?.cover_i) {
      coverId = search.cover_i;
      if (!metadata.title && search.title) metadata.title = search.title;
      if (!metadata.author && search.author_name?.length) {
        metadata.author = search.author_name.join(", ");
      }
      coverSource = "openlibrary_search_isbn";
    }
  }

  let coverBytes: CoverBytes | null = null;
  if (coverId) {
    try {
      coverBytes = await fetchOpenLibraryCoverBytes(coverId, {
        fetchFn: deps.fetchFn,
      });
    } catch (err) {
      console.warn("catalog_openlibrary_cover_failed", {
        isbn,
        coverId,
        error: String(err),
      });
      coverBytes = null;
    }
    metadata.openlibrary_cover_id = coverId;
  }

  return { coverBytes, coverSource, coverId };
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

  const existing = await selectByIsbn(supabase, isbn);
  if (existing && (existing.storage_path || isFreshNegative(existing, now))) {
    return { cached: true, rateLimited: false, row: existing };
  }

  const olOk = await tryAcquire(deps.rateLimiters.openLibrary);
  if (!olOk) {
    return { cached: false, rateLimited: true, row: existing ?? { isbn } };
  }

  // 1. Open Library data + work
  const { olData, olWork } = await loadOpenLibraryData(isbn, deps);
  const metadata: CatalogMetadata = extractOpenLibraryMetadata(
    olData as never,
    olWork as never,
  );

  // 2. Open Library cover (data → search-by-isbn fallback)
  const ol = await resolveOpenLibraryCover(olData, isbn, metadata, deps);
  let coverBytes = ol.coverBytes;
  let coverSource = ol.coverSource;

  // 3. Google Books fallback (description and/or cover)
  const gbResult = await enrichWithGoogleBooks(
    metadata,
    coverBytes,
    () =>
      fetchGoogleBooksByIsbn(isbn, {
        fetchFn: deps.fetchFn,
        apiKey: deps.googleBooksApiKey,
      }),
    {
      deps,
      do_not_refetch_description: existing?.do_not_refetch_description ?? false,
      logCtx: { isbn },
    },
  );
  coverBytes = gbResult.coverBytes;
  if (gbResult.coverSource) coverSource = gbResult.coverSource;

  // 4. Persist cover bytes (with byte-level dedup)
  const storage = await persistCover(supabase, coverBytes, upload);

  // 5. Build upsert payload + write
  const upsertRow = {
    isbn,
    storage_path: storage?.storage_path ?? null,
    cover_storage_backend: storage?.backend ?? null,
    image_sha256: storage?.image_sha256 ?? null,
    cover_source: coverSource ?? null,
    openlibrary_cover_id: metadata.openlibrary_cover_id ?? null,
    google_volume_id: metadata.google_volume_id ?? null,
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

  const olOk = await tryAcquire(deps.rateLimiters.openLibrary);
  if (!olOk) {
    return {
      cached: false,
      rateLimited: true,
      row: existing ?? { normalized_title_author: key },
    };
  }

  // 1. Open Library search by title/author
  let search: Awaited<ReturnType<typeof searchOpenLibraryByTitleAuthor>> = null;
  try {
    search = await searchOpenLibraryByTitleAuthor(title, author, {
      fetchFn: deps.fetchFn,
    });
  } catch (err) {
    console.warn("catalog_openlibrary_search_failed", {
      title,
      author,
      error: String(err),
    });
  }

  const metadata: CatalogMetadata = {};
  let coverBytes: CoverBytes | null = null;
  let coverSource: CoverSource | undefined;

  if (search?.cover_i) {
    try {
      coverBytes = await fetchOpenLibraryCoverBytes(search.cover_i, {
        fetchFn: deps.fetchFn,
      });
    } catch (err) {
      console.warn("catalog_openlibrary_cover_failed", {
        title,
        author,
        coverId: search.cover_i,
        error: String(err),
      });
      coverBytes = null;
    }
    if (search.title) metadata.title = search.title;
    if (search.author_name?.length)
      metadata.author = search.author_name.join(", ");
    coverSource = "openlibrary_search_title";
  }

  // 2. Google Books fallback (description and/or cover)
  const gbResult = await enrichWithGoogleBooks(
    metadata,
    coverBytes,
    () =>
      fetchGoogleBooksByTitleAuthor(title, author, {
        fetchFn: deps.fetchFn,
        apiKey: deps.googleBooksApiKey,
      }),
    {
      deps,
      do_not_refetch_description: existing?.do_not_refetch_description ?? false,
      logCtx: { title, author },
    },
  );
  coverBytes = gbResult.coverBytes;
  if (gbResult.coverSource) coverSource = gbResult.coverSource;

  // 3. Persist cover bytes (with byte-level dedup)
  const storage = await persistCover(supabase, coverBytes, upload);

  // 4. Build upsert payload + write
  const upsertRow = {
    isbn: null as string | null,
    normalized_title_author: key,
    storage_path: storage?.storage_path ?? null,
    cover_storage_backend: storage?.backend ?? null,
    image_sha256: storage?.image_sha256 ?? null,
    cover_source: coverSource ?? null,
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
}
