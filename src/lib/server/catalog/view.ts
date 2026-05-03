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
