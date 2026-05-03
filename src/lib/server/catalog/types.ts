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
export type BookCatalogRow = Omit<
  Database["public"]["Tables"]["book_catalog"]["Row"],
  "cover_storage_backend" | "description_provider" | "cover_source"
> & {
  cover_storage_backend: CoverStorageBackend | null;
  description_provider: DescriptionProvider | null;
  cover_source: CoverSource | null;
};
