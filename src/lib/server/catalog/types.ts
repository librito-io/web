// Upstream API response shapes — shared across catalog modules

import type { Database } from "$lib/db.types";

export interface OpenLibraryAuthor {
  name?: string;
}

export interface OpenLibraryPublisher {
  name?: string;
}

export interface OpenLibraryDataDoc {
  title?: string;
  authors?: OpenLibraryAuthor[];
  publishers?: OpenLibraryPublisher[];
  number_of_pages?: number;
  publish_date?: string;
  subjects?: { name: string }[] | string[];
  cover?: { large?: string; medium?: string; small?: string };
  url?: string;
  identifiers?: { isbn_10?: string[]; [key: string]: string[] | undefined };
  works?: { key: string }[];
}

export interface OpenLibraryWork {
  description?: string | { value: string };
  subjects?: string[];
}

export interface OpenLibrarySearchDoc {
  cover_i?: number;
  title?: string;
  author_name?: string[];
  key?: string;
}

export interface GoogleBooksItem {
  id: string;
  volumeInfo: {
    title?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    pageCount?: number;
    language?: string;
    categories?: string[];
    imageLinks?: { thumbnail?: string; large?: string };
    industryIdentifiers?: { type: string; identifier: string }[];
  };
}

export type CoverStorageBackend = "cloudflare-images" | "supabase";
export type CoverVariant = "thumbnail" | "medium" | "large";
export type DescriptionProvider = "openlibrary" | "google_books" | "manual";
export type CoverSource =
  | "openlibrary_isbn"
  | "openlibrary_search_isbn"
  | "openlibrary_search_title"
  | "google_books";

export interface CatalogMetadata {
  title?: string;
  author?: string;
  description?: string;
  description_raw?: string;
  description_provider?: DescriptionProvider;
  published_date?: string;
  publisher?: string;
  page_count?: number;
  language?: string;
  subjects?: string[];
  series_name?: string;
  series_position?: number;
  isbn_10?: string;
  openlibrary_cover_id?: number;
  google_volume_id?: string;
  source_url?: string;
}

// Derived from the generated `Database` row type (`npm run gen:types`) so
// migrations and TypeScript stay in lockstep — adding a column without
// regenerating types fails typecheck instead of drifting silently. The
// generated type widens project-specific literal unions
// (`cover_storage_backend`, `description_provider`, `cover_source`) to
// `string | null`; we override those three fields back to their literal
// unions so call sites keep narrow types.
//
// The row is then split into a discriminated union mirroring the DB-level
// CHECK constraint `book_catalog_storage_consistency` (migration
// `20260503000001`): either both `storage_path` and `cover_storage_backend`
// are NULL (negative cache row — lookup attempted, no cover available) or
// both are non-null (positive row with stored cover). Single-side NULL is
// rejected by the DB and is therefore unrepresentable in TypeScript.
// Pre-discriminant shape — fields independently nullable, mirroring the
// generated row before the `book_catalog_storage_consistency` CHECK is
// lifted into TypeScript. Use this for in-flight upsert payloads where the
// discriminant pairing is enforced by construction (e.g. the
// `storage_path` / `cover_storage_backend` pair both fall through the same
// `storage?` null check) rather than by type. Reads from the DB should
// always go through the discriminated `BookCatalogRow` instead.
export type BookCatalogRowFields = Omit<
  Database["public"]["Tables"]["book_catalog"]["Row"],
  "cover_storage_backend" | "description_provider" | "cover_source"
> & {
  cover_storage_backend: CoverStorageBackend | null;
  description_provider: DescriptionProvider | null;
  cover_source: CoverSource | null;
};

export type PositiveBookCatalogRow = Omit<
  BookCatalogRowFields,
  "storage_path" | "cover_storage_backend"
> & {
  storage_path: string;
  cover_storage_backend: CoverStorageBackend;
};

export type NegativeBookCatalogRow = Omit<
  BookCatalogRowFields,
  "storage_path" | "cover_storage_backend"
> & {
  storage_path: null;
  cover_storage_backend: null;
};

export type BookCatalogRow = PositiveBookCatalogRow | NegativeBookCatalogRow;

// Type guard narrowing a row (or any structural subset carrying the storage
// discriminant) into the positive variant. Accepts the structural shape so
// it composes with column-projected selects (`Partial<BookCatalogRow>`,
// pick-style projections) without forcing call sites to cast up to the full
// row first.
export function hasCoverStorage<
  T extends {
    storage_path?: string | null | undefined;
    cover_storage_backend?: CoverStorageBackend | null | undefined;
  },
>(
  row: T,
): row is T & {
  storage_path: string;
  cover_storage_backend: CoverStorageBackend;
} {
  return row.storage_path != null && row.cover_storage_backend != null;
}
