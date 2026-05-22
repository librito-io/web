import type { SupabaseClient } from "@supabase/supabase-js";
import { coverUrl } from "$lib/server/cover-storage";
import { normalizeTitleAuthor } from "./title-author";
import {
  hasCoverStorage,
  type BookCatalogRow,
  type CoverVariant,
} from "./types";

// Placeholder cover URL substituted when a row has no stored cover
// (storage_path null) or no row exists at all. Public asset under /static.
export const PLACEHOLDER_COVER_URL = "/cover-placeholder.svg";

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
  | "cover_max_width"
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

/**
 * JSON response shape returned by `GET /app/api/book-catalog/[isbn]`.
 *
 * Deriving from CatalogView via Pick keeps the API surface in lockstep
 * with the underlying view: adding a column to CatalogView surfaces as
 * a typecheck failure on `toCatalogResponse` and on any consumer that
 * destructures this type (audit #18).
 */
export type CatalogResponse = Pick<
  CatalogView,
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
> & {
  cover_url: string;
  cold_miss: boolean;
};

/**
 * Project a CatalogView (or null, when no row exists) into the API
 * response shape. Collapses the hit-vs-cold-miss field duplication that
 * lived in the route handler: both branches share the same metadata
 * projection and only differ on `cover_url` / `cold_miss`.
 *
 * Cold miss is defined as "no row, or row exists but storage_path is
 * null" — both surface to the client as placeholder URL + cold_miss=true
 * so the route can schedule background resolve work uniformly.
 */
export function toCatalogResponse(
  view: CatalogView | null,
  isbn: string,
): CatalogResponse {
  return {
    isbn,
    title: view?.title ?? null,
    author: view?.author ?? null,
    description: view?.description ?? null,
    description_provider: view?.description_provider ?? null,
    publisher: view?.publisher ?? null,
    page_count: view?.page_count ?? null,
    subjects: view?.subjects ?? null,
    published_date: view?.published_date ?? null,
    language: view?.language ?? null,
    series_name: view?.series_name ?? null,
    series_position: view?.series_position ?? null,
    cover_url: view?.cover_url ?? PLACEHOLDER_COVER_URL,
    cold_miss: !view || view.cover_url === null,
  };
}

const CATALOG_SELECT =
  "isbn, title, author, description, description_provider, publisher, " +
  "page_count, subjects, published_date, language, series_name, series_position, " +
  "storage_path, cover_storage_backend, cover_max_width";

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
    | "cover_max_width"
  >;

  const resolvedCoverUrl = hasCoverStorage(row)
    ? coverUrl(
        row.storage_path,
        row.cover_storage_backend,
        variant,
        row.cover_max_width,
      )
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
    cover_max_width: row.cover_max_width,
    cover_url: resolvedCoverUrl,
  };
}

export type CoverUrlsByIsbnsResult = {
  covers: Map<string, string>;
  negativeIsbns: Set<string>;
};

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
 * @returns `{ covers, negativeIsbns }`.
 *   - `covers`: Map keyed by canonical ISBN, populated for rows with a
 *     positive (storage_path non-null) entry.
 *   - `negativeIsbns`: Set of canonical ISBNs whose row exists but has
 *     storage_path null (catalog tried, found nothing).
 *
 *   ISBNs with no row at all appear in neither — caller schedules a
 *   cold-miss resolve. Issue #110: returning both surfaces lets
 *   feed-enrichment skip the cold-miss schedule for negative-cached
 *   ISBNs, so the warmup cron (not the request path) handles retry.
 */
export async function getCoverUrlsByIsbns(
  supabase: SupabaseClient,
  isbns: string[],
  variant: CoverVariant = "thumbnail",
): Promise<CoverUrlsByIsbnsResult> {
  const covers = new Map<string, string>();
  const negativeIsbns = new Set<string>();
  if (isbns.length === 0) return { covers, negativeIsbns };
  const unique = Array.from(new Set(isbns));

  const { data: rawData, error } = await supabase
    .from("book_catalog")
    .select("isbn, storage_path, cover_storage_backend, cover_max_width")
    .in("isbn", unique);

  if (error) {
    throw error;
  }
  if (!rawData) return { covers, negativeIsbns };

  // Cast at the boundary — same pattern as getCatalogForBrowser. The
  // Pick<> distributes across the discriminated union so hasCoverStorage()
  // narrows cleanly without escaping to the full row type.
  const rows = rawData as unknown as Pick<
    BookCatalogRow,
    "isbn" | "storage_path" | "cover_storage_backend" | "cover_max_width"
  >[];

  for (const row of rows) {
    // Skip rows whose isbn is null — book_catalog allows isbn-null rows
    // keyed on (title, author) for ISBN-less books, but this helper's
    // contract is "lookup by ISBN". A null-isbn row arriving here would
    // imply a query bug; defensive skip.
    if (row.isbn === null) continue;
    if (hasCoverStorage(row)) {
      covers.set(
        row.isbn,
        coverUrl(
          row.storage_path,
          row.cover_storage_backend,
          variant,
          row.cover_max_width,
        ),
      );
    } else {
      negativeIsbns.add(row.isbn);
    }
  }
  return { covers, negativeIsbns };
}

/**
 * Title+author sibling of `getCatalogForBrowser`. Looks up the ISBN-less
 * row keyed on `normalized_title_author` (partial unique index, scope
 * `isbn IS NULL`). Returns null when title/author cannot be normalized
 * (one side empty after stripping) or when no row exists.
 *
 * Same return shape as `getCatalogForBrowser` so call sites can branch on
 * ISBN presence without diverging downstream view-model construction.
 */
export async function getCatalogForBrowserByTitleAuthor(
  supabase: SupabaseClient,
  title: string,
  author: string,
  variant: CoverVariant = "medium",
): Promise<CatalogView | null> {
  const key = normalizeTitleAuthor(title, author);
  if (!key) return null;

  const { data: rawData, error } = await supabase
    .from("book_catalog")
    .select(CATALOG_SELECT)
    .is("isbn", null)
    .eq("normalized_title_author", key)
    .maybeSingle();

  if (error) throw error;
  if (!rawData) return null;

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
    | "cover_max_width"
  >;

  const resolvedCoverUrl = hasCoverStorage(row)
    ? coverUrl(
        row.storage_path,
        row.cover_storage_backend,
        variant,
        row.cover_max_width,
      )
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
    cover_max_width: row.cover_max_width,
    cover_url: resolvedCoverUrl,
  };
}

export type CoverUrlsByTitleAuthorResult = {
  covers: Map<string, string>;
  negativeKeys: Set<string>;
};

/**
 * Batch-resolve cover URLs for ISBN-less books keyed on (title, author).
 * Mirrors `getCoverUrlsByIsbns` for the title/author branch of the
 * feed-enrichment path. Pairs whose normalization yields null (one side
 * empty after stripping) are silently skipped — caller renders placeholder.
 *
 * @returns `{ covers, negativeKeys }`.
 *   - `covers`: Map keyed on `normalized_title_author` (the partial-unique-
 *     index key), populated for positive (cover-bearing) rows.
 *   - `negativeKeys`: Set of normalized keys whose row exists with
 *     storage_path null. Issue #110: caller subtracts both from cold-miss
 *     schedule so warmup cron handles negative-cache retry.
 */
export async function getCoverUrlsByTitleAuthor(
  supabase: SupabaseClient,
  pairs: { title: string; author: string }[],
  variant: CoverVariant = "thumbnail",
): Promise<CoverUrlsByTitleAuthorResult> {
  const covers = new Map<string, string>();
  const negativeKeys = new Set<string>();
  if (pairs.length === 0) return { covers, negativeKeys };

  const keys = new Set<string>();
  for (const p of pairs) {
    const k = normalizeTitleAuthor(p.title, p.author);
    if (k) keys.add(k);
  }
  if (keys.size === 0) return { covers, negativeKeys };

  const { data: rawData, error } = await supabase
    .from("book_catalog")
    .select(
      "normalized_title_author, storage_path, cover_storage_backend, cover_max_width",
    )
    .is("isbn", null)
    .in("normalized_title_author", Array.from(keys));

  if (error) throw error;
  if (!rawData) return { covers, negativeKeys };

  const rows = rawData as unknown as Pick<
    BookCatalogRow,
    | "normalized_title_author"
    | "storage_path"
    | "cover_storage_backend"
    | "cover_max_width"
  >[];

  for (const row of rows) {
    if (!row.normalized_title_author) continue;
    if (hasCoverStorage(row)) {
      covers.set(
        row.normalized_title_author,
        coverUrl(
          row.storage_path,
          row.cover_storage_backend,
          variant,
          row.cover_max_width,
        ),
      );
    } else {
      negativeKeys.add(row.normalized_title_author);
    }
  }
  return { covers, negativeKeys };
}
