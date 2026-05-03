import type { SupabaseClient } from "@supabase/supabase-js";
import { coverUrl } from "$lib/server/cover-storage";
import {
  hasCoverStorage,
  type BookCatalogRow,
  type CoverVariant,
} from "./types";

// Columns the browser-facing surfaces project from book_catalog.
// Pick<BookCatalogRow, K> distributes across the discriminated union
// (Pick<A | B, K> ≡ Pick<A, K> | Pick<B, K>), so the storage discriminant
// (storage_path + cover_storage_backend) is preserved and hasCoverStorage()
// narrows cleanly. K must include both discriminant columns — see PR 1 lesson.
export type CatalogView = Pick<
  BookCatalogRow,
  | "isbn"
  | "title"
  | "author"
  | "description"
  | "description_provider"
  | "publisher"
  | "page_count"
  | "subjects"
  | "published_date"
  | "language"
  | "series_name"
  | "series_position"
  | "storage_path"
  | "cover_storage_backend"
> & {
  // Resolved cover URL — null for negative-cache rows (storage_path is null).
  cover_url: string | null;
};

/**
 * Catalog metadata projected for the book-detail page (`/app/book/[bookHash]`).
 *
 * Differs from CatalogView in two ways:
 *   - cover_url is always a string (placeholder URL substituted for the
 *     null negative-cache state) — the detail page renders an <img> tag
 *     unconditionally rather than branching on null.
 *   - Excludes columns the detail surface does not use (isbn / title /
 *     author come from the `books` row, not book_catalog; storage
 *     discriminants are internal-only).
 *
 * Deriving from CatalogView via Pick ensures new catalog columns
 * automatically surface as a typecheck failure here (audit #21) — add
 * a field to CatalogView and TypeScript will flag any call site that
 * initialises a BookDetailCatalog without it.
 */
export type BookDetailCatalog = Pick<
  CatalogView,
  | "description"
  | "description_provider"
  | "publisher"
  | "page_count"
  | "subjects"
  | "published_date"
> & {
  cover_url: string;
};

const CATALOG_SELECT =
  "isbn, title, author, description, description_provider, publisher, " +
  "page_count, subjects, published_date, language, series_name, series_position, " +
  "storage_path, cover_storage_backend";

/**
 * Fetch a single book_catalog row for browser-facing surfaces and resolve its
 * cover URL. Consolidates the SELECT + cover_url derivation that was duplicated
 * across the API handler and the book-detail page loader (audit #6).
 *
 * @param supabase - Per-request Supabase client (RLS-bound or admin; caller
 *   decides). Neither call site re-uses this client for privileged writes here.
 * @param isbn    - Canonicalized ISBN (validated by caller before passing in).
 * @param variant - Cover size variant passed to coverUrl(). Callers differ:
 *   the API handler uses "medium" (or a query-param override); the page loader
 *   uses "large". Defaulting to "medium" matches the API handler's default.
 * @returns CatalogView with cover_url resolved, or null if no row exists.
 *   cover_url is null for negative-cache rows (storage_path / backend both null).
 */
export async function getCatalogForBrowser(
  supabase: SupabaseClient,
  isbn: string,
  variant: CoverVariant = "medium",
): Promise<CatalogView | null> {
  const { data: rawData, error } = await supabase
    .from("book_catalog")
    .select(CATALOG_SELECT)
    .eq("isbn", isbn)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!rawData) {
    return null;
  }

  // Cast at the boundary: rawData is typed as NonNullable<DB row> | GenericStringError
  // by the generated Supabase client, so the direct cast must go via `unknown`
  // first. Pick<BookCatalogRow, K> distributes across the discriminated union so
  // hasCoverStorage() narrows cleanly without requiring a cast up to the full
  // row. Keep the Pick key list in sync with CATALOG_SELECT above — TS will
  // error on any access to a non-projected column.
  const row = rawData as unknown as Pick<
    BookCatalogRow,
    | "isbn"
    | "title"
    | "author"
    | "description"
    | "description_provider"
    | "publisher"
    | "page_count"
    | "subjects"
    | "published_date"
    | "language"
    | "series_name"
    | "series_position"
    | "storage_path"
    | "cover_storage_backend"
  >;

  const resolvedCoverUrl = hasCoverStorage(row)
    ? coverUrl(row.storage_path, row.cover_storage_backend, variant)
    : null;

  return {
    isbn: row.isbn,
    title: row.title,
    author: row.author,
    description: row.description,
    description_provider: row.description_provider,
    publisher: row.publisher,
    page_count: row.page_count,
    subjects: row.subjects,
    published_date: row.published_date,
    language: row.language,
    series_name: row.series_name,
    series_position: row.series_position,
    storage_path: row.storage_path,
    cover_storage_backend: row.cover_storage_backend,
    cover_url: resolvedCoverUrl,
  };
}

/**
 * Batch-resolve cover URLs for a list of ISBNs from `book_catalog`. Powers the
 * highlight-feed card thumbnails: one round-trip for the whole feed page rather
 * than N per-card lookups.
 *
 * Single SELECT projecting only the storage discriminant — no metadata,
 * since callers only need the URL.
 *
 * @param supabase - Per-request Supabase client (RLS-bound or admin; caller
 *   decides). Reads from `book_catalog` only — no privileged writes.
 * @param isbns - Canonical ISBNs (caller's responsibility to canonicalize via
 *   `canonicalizeIsbn`). Duplicates are deduped internally before the query.
 * @param variant - Cover size variant passed to `coverUrl()`. Defaults to
 *   "thumbnail" for the feed-card use case (200×300 @ q80, retina @3x for the
 *   67×100 box). On the current Supabase Storage backend the variant is a
 *   layout hint only; on Cloudflare Images it picks the rendered size.
 * @returns Map keyed by canonical ISBN. Only ISBNs with a positive
 *   (`storage_path` non-null) row produce an entry; negative-cache rows and
 *   absent rows are both omitted, so the caller renders the placeholder for
 *   any missing key.
 *
 *   Negative-cache rows (catalog tried, found nothing) get no Map entry —
 *   caller renders placeholder. Catalog warmup cron is the retry path; cold-
 *   miss scheduling here would burn budget on a known-failing resolve.
 */
export async function getCoverUrlsByIsbns(
  supabase: SupabaseClient,
  isbns: string[],
  variant: CoverVariant = "thumbnail",
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (isbns.length === 0) return result;
  const unique = Array.from(new Set(isbns));

  const { data: rawData, error } = await supabase
    .from("book_catalog")
    .select("isbn, storage_path, cover_storage_backend")
    .in("isbn", unique);

  if (error) {
    throw error;
  }
  if (!rawData) return result;

  // Cast at the boundary — same pattern as getCatalogForBrowser. The
  // Pick<> distributes across the discriminated union so hasCoverStorage()
  // narrows cleanly without escaping to the full row type.
  const rows = rawData as unknown as Pick<
    BookCatalogRow,
    "isbn" | "storage_path" | "cover_storage_backend"
  >[];

  for (const row of rows) {
    // Skip rows whose isbn is null — book_catalog allows isbn-null rows
    // keyed on (title, author) for ISBN-less books, but this helper's
    // contract is "lookup by ISBN". A null-isbn row arriving here would
    // imply a query bug; defensive skip.
    if (row.isbn === null) continue;
    if (!hasCoverStorage(row)) continue;
    result.set(
      row.isbn,
      coverUrl(row.storage_path, row.cover_storage_backend, variant),
    );
  }
  return result;
}
