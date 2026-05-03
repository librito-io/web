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
import type {
  BookCatalogRow,
  CatalogMetadata,
  CoverSource,
  CoverStorageBackend,
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
  row: Partial<BookCatalogRow>;
}

async function selectByIsbn(
  supabase: SupabaseClient,
  isbn: string,
): Promise<Partial<BookCatalogRow> | null> {
  const { data, error } = await supabase
    .from("book_catalog")
    .select("*")
    .eq("isbn", isbn)
    .maybeSingle();
  if (error) throw new Error(`book_catalog select: ${error.message}`);
  return (data as Partial<BookCatalogRow> | null) ?? null;
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
  if (error) return null;
  return (data as never) ?? null;
}

function isFreshNegative(row: Partial<BookCatalogRow>, now: Date): boolean {
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

  // 1. Open Library by ISBN
  const olData = (await fetchOpenLibraryByIsbn(isbn, {
    fetchFn: deps.fetchFn,
  })) as { works?: { key: string }[]; cover?: { large?: string } } | null;
  let olWork: unknown = null;
  if (
    olData &&
    Array.isArray((olData as { works?: { key: string }[] }).works)
  ) {
    const wk = (olData as { works: { key: string }[] }).works[0]?.key;
    const id = wk?.replace(/^\/works\//, "");
    if (id) {
      try {
        olWork = await fetchOpenLibraryWork(id, { fetchFn: deps.fetchFn });
      } catch {
        /* tolerate work fetch errors */
      }
    }
  }

  let metadata: CatalogMetadata = extractOpenLibraryMetadata(
    olData as never,
    olWork as never,
  );
  let coverSource: CoverSource | undefined;
  let coverBytes: { bytes: Uint8Array; mime: string } | null = null;

  // 2. Cover from data → search-by-isbn
  let olCoverId: number | undefined;
  const coverLargeUrl = (olData as { cover?: { large?: string } } | null)?.cover
    ?.large;
  if (coverLargeUrl) {
    const m = coverLargeUrl.match(/\/id\/(\d+)-/);
    if (m) olCoverId = Number(m[1]);
  }
  if (!olCoverId) {
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
      olCoverId = search.cover_i;
      if (!metadata.title && search.title) metadata.title = search.title;
      if (!metadata.author && search.author_name?.length) {
        metadata.author = search.author_name.join(", ");
      }
      coverSource = "openlibrary_search_isbn";
    }
  } else {
    coverSource = "openlibrary_isbn";
  }
  if (olCoverId) {
    try {
      coverBytes = await fetchOpenLibraryCoverBytes(olCoverId, {
        fetchFn: deps.fetchFn,
      });
    } catch (err) {
      console.warn("catalog_openlibrary_cover_failed", {
        isbn,
        coverId: olCoverId,
        error: String(err),
      });
      coverBytes = null;
    }
    metadata.openlibrary_cover_id = olCoverId;
  }

  // 3. Google Books fallback for description (and cover if needed)
  // The do_not_refetch_description flag gates description text only (publisher
  // takedowns target marketing copy, not cover images). Cover fallback proceeds
  // unconditionally so a takedown'd ISBN with no OL cover doesn't end up
  // permanently coverless.
  if (!metadata.description || !coverBytes) {
    const gbOk = await tryAcquire(deps.rateLimiters.googleBooks);
    if (gbOk) {
      try {
        const gb = await fetchGoogleBooksByIsbn(isbn, {
          fetchFn: deps.fetchFn,
          apiKey: deps.googleBooksApiKey,
        });
        if (gb) {
          const gbMeta = extractGoogleBooksMetadata(gb);
          if (
            !metadata.description &&
            gbMeta.description &&
            !existing?.do_not_refetch_description
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
                  fetchFn: deps.fetchFn,
                });
              } catch (err) {
                console.warn("catalog_googlebooks_cover_failed", {
                  isbn,
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
          isbn,
          error: String(err),
        });
      }
    }
  }

  // Storage (with byte-level dedup)
  let storage: {
    storage_path: string;
    backend: CoverStorageBackend;
    image_sha256: string;
  } | null = null;
  if (coverBytes) {
    const sha = await sha256Hex(coverBytes.bytes);
    const dedup = await selectBySha(supabase, sha);
    storage = dedup
      ? {
          storage_path: dedup.storage_path,
          backend: dedup.cover_storage_backend,
          image_sha256: sha,
        }
      : await upload(coverBytes.bytes, coverBytes.mime, {});
  }

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

  const { data: existing, error: selErr } = await supabase
    .from("book_catalog")
    .select("*")
    .is("isbn", null)
    .eq("normalized_title_author", key)
    .maybeSingle();
  if (selErr) throw new Error(`book_catalog select: ${selErr.message}`);

  const e = existing as Partial<BookCatalogRow> | null;
  if (e && (e.storage_path || isFreshNegative(e, now))) {
    return { cached: true, rateLimited: false, row: e };
  }

  const olOk = await tryAcquire(deps.rateLimiters.openLibrary);
  if (!olOk) {
    return {
      cached: false,
      rateLimited: true,
      row: e ?? { normalized_title_author: key },
    };
  }

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
  let coverBytes: { bytes: Uint8Array; mime: string } | null = null;
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

  // Google Books fallback for description (and cover if needed).
  // The do_not_refetch_description flag gates description text only — same
  // reasoning as resolveIsbn: takedowns target marketing copy, not covers.
  // Outer condition broadened from `!metadata.description` to include
  // `!coverBytes` so the cover fallback runs even when description is
  // intentionally being skipped due to the flag.
  if (!metadata.description || !coverBytes) {
    const gbOk = await tryAcquire(deps.rateLimiters.googleBooks);
    if (gbOk) {
      try {
        const gb = await fetchGoogleBooksByTitleAuthor(title, author, {
          fetchFn: deps.fetchFn,
          apiKey: deps.googleBooksApiKey,
        });
        if (gb) {
          const m = extractGoogleBooksMetadata(gb);
          if (m.description && !e?.do_not_refetch_description) {
            metadata.description_raw = m.description;
            metadata.description = stripMarketingCruft(m.description);
            metadata.description_provider = "google_books";
            metadata.google_volume_id = m.google_volume_id;
          }
          if (!coverBytes) {
            const link =
              gb.volumeInfo?.imageLinks?.large ??
              gb.volumeInfo?.imageLinks?.thumbnail;
            if (link) {
              try {
                coverBytes = await fetchGoogleBooksCoverBytes(link, {
                  fetchFn: deps.fetchFn,
                });
              } catch (err) {
                console.warn("catalog_googlebooks_cover_failed", {
                  title,
                  author,
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
          title,
          author,
          error: String(err),
        });
      }
    }
  }

  let storage: {
    storage_path: string;
    backend: CoverStorageBackend;
    image_sha256: string;
  } | null = null;
  if (coverBytes) {
    const sha = await sha256Hex(coverBytes.bytes);
    const dedup = await selectBySha(supabase, sha);
    storage = dedup
      ? {
          storage_path: dedup.storage_path,
          backend: dedup.cover_storage_backend,
          image_sha256: sha,
        }
      : await upload(coverBytes.bytes, coverBytes.mime, {});
  }

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
      : (e?.fetched_at ?? now.toISOString()),
    last_attempted_at: now.toISOString(),
    attempt_count: (e?.attempt_count ?? 0) + 1,
  };

  // Same partial-index reason as resolveIsbn — route via RPC.
  const { error: upErr } = await supabase.rpc(
    "upsert_book_catalog_by_title_author",
    { p_row: upsertRow },
  );
  if (upErr) throw new Error(`book_catalog upsert: ${upErr.message}`);

  return { cached: false, rateLimited: false, row: upsertRow };
}
