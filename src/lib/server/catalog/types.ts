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

export interface BookCatalogRow {
  id: string;
  isbn: string | null;
  normalized_title_author: string | null;
  storage_path: string | null;
  cover_storage_backend: CoverStorageBackend | null;
  image_sha256: string | null;
  cover_source: CoverSource | null;
  openlibrary_cover_id: number | null;
  google_volume_id: string | null;
  source_url: string | null;
  fetched_at: string;
  last_attempted_at: string;
  attempt_count: number;
  title: string | null;
  author: string | null;
  description: string | null;
  description_raw: string | null;
  description_provider: DescriptionProvider | null;
  published_date: string | null;
  publisher: string | null;
  page_count: number | null;
  language: string | null;
  subjects: string[] | null;
  series_name: string | null;
  series_position: number | null;
  isbn_10: string | null;
  do_not_refetch_description: boolean;
}
