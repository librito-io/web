// Upstream API response shapes — shared across catalog modules

import type { Database } from "$lib/types/database";
import type { FailReason } from "$lib/catalog/tracked-fields";

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
  subjects?: (string | { name: string })[];
  cover?: { large?: string; medium?: string; small?: string };
  url?: string;
  identifiers?: { isbn_10?: string[]; [key: string]: string[] | undefined };
  works?: { key: string }[];
}

export interface OpenLibraryWork {
  key?: string;
  description?: string | { value: string };
  subjects?: string[];
  // Work-level cover IDs, highest-priority first. Walked by WorkCoverWalker
  // before edition-level covers. OL uses -1 / 0 as "no cover" sentinels.
  covers?: number[];
}

export interface OpenLibrarySearchDoc {
  cover_i?: number;
  title?: string;
  author_name?: string[];
  key?: string;
  // Ranking signals (requested by searchOpenLibraryWorksByTitleAuthor).
  edition_count?: number;
  first_publish_year?: number;
}

// /works/{key}/editions.json response. Only the per-edition cover IDs are
// consumed (WorkCoverWalker phase 2). Each entry's `covers` is OL's
// edition-level cover list, same -1/0 sentinel convention as work.covers.
export interface OpenLibraryEditionsResponse {
  entries?: { covers?: number[] }[];
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
    imageLinks?: {
      smallThumbnail?: string;
      thumbnail?: string;
      small?: string;
      medium?: string;
      large?: string;
      extraLarge?: string;
    };
    industryIdentifiers?: { type: string; identifier: string }[];
  };
  /**
   * Volume access metadata. Sits at the GoogleBooks API response root,
   * NOT inside `volumeInfo` — easy to misnest. Used by the resolver chain
   * to discriminate "real cover scan exists" (pdf.isAvailable=true) from
   * "metadata-only volume; imageLinks bytes are publisher InDesign
   * template artifacts" (pdf.isAvailable=false). See issue #209 revised
   * mechanism + 2026-05-18 n=9 empirical study.
   *
   * Only fields with current consumers are declared. Add more (embeddable,
   * publicDomain, epub.isAvailable, pdf.acsTokenLink, webReaderLink) only
   * when an actual reader appears — the GB API returns more than this.
   */
  accessInfo?: {
    viewability?:
      | "NO_PAGES"
      | "PARTIAL"
      | "ALL_PAGES"
      | "ALL_PAGES_AVAILABLE"
      | string;
    pdf?: { isAvailable?: boolean };
  };
}

export type CoverStorageBackend = "cloudflare-images" | "supabase";
export type CoverVariant = "thumbnail" | "medium" | "large" | "xlarge";
// 'itunes' added in the 2026-05-27 refit alongside the new third
// description-chain leg. DB CHECK widened in migration 20260527000001;
// resolver wiring lands in PR2.
export type DescriptionProvider =
  | "openlibrary"
  | "google_books"
  | "itunes"
  | "manual";
// "openlibrary_search_isbn" was emitted by an earlier OL-primary resolver
// that distinguished data-document-derived from search-derived cover_ids.
// The current chain (issue #199) unifies both paths under "openlibrary_isbn"
// because the search distinction has no consumer. Pre-issue-#199 rows in
// production may still carry "openlibrary_search_isbn"; the DB column is
// `text` (not enum), so legacy rows remain valid. Do not add this literal
// back to the union — there's no code path producing it.
//
// "openlibrary_isbn_direct" (issue #211, plan 2026-05-18) sources bytes
// from covers.openlibrary.org/b/isbn/{isbn}-L.jpg, which resolves against
// any edition of the underlying Work with cover bytes. Distinct from
// "openlibrary_isbn" (covers/b/id/{coverId}-L.jpg, requires explicit
// coverId discovery via /api/books or /search.json). Direct tier sits
// first in the chain — precision-first ordering.
export type CoverSource =
  | "openlibrary_isbn_direct"
  | "openlibrary_isbn"
  | "openlibrary_search_title"
  // Walked from the chosen work's cover editions (work-resolver). DB CHECK
  // widened in a later migration in this branch.
  | "openlibrary_work"
  | "google_books"
  | "itunes"
  // 'manual' added in the 2026-05-27 refit for operator-uploaded covers
  // (PR5 admin route). DB CHECK widened in migration 20260527000001.
  | "manual";

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
// Considered + rejected: converting these three columns to Postgres
// enums (#98). Kept text+CHECK for schema flexibility on the two
// data-source columns (`description_provider`, `cover_source`); see
// the closed issue for full reasoning.
//
// The row is then split into a discriminated union mirroring the DB-level
// CHECK constraint `book_catalog_storage_consistency` (migration
// `20260503000001`): either both `storage_path` and `cover_storage_backend`
// are NULL (negative cache row — lookup attempted, no cover available) or
// both are non-null (positive row with stored cover). Single-side NULL is
// rejected by the DB and is therefore unrepresentable in TypeScript.
/**
 * Pre-discriminant shape for upsert-payload construction only.
 *
 * Read paths must use `BookCatalogRow` (discriminated) and narrow via
 * `hasCoverStorage()`. New uses outside upsert-payload construction
 * should be reviewed — they likely indicate the discriminator is
 * being escaped where it shouldn't be.
 *
 * Fields are independently nullable here, mirroring the generated row
 * before the `book_catalog_storage_consistency` CHECK is lifted into
 * TypeScript. Use this for in-flight upsert payloads where the
 * discriminant pairing is enforced by construction (e.g. the
 * `storage_path` / `cover_storage_backend` pair both fall through the
 * same `storage?` null check) rather than by type.
 */
export type BookCatalogRowFields = Omit<
  Database["public"]["Tables"]["book_catalog"]["Row"],
  | "cover_storage_backend"
  | "description_provider"
  | "cover_source"
  | "publisher_provider"
  | "published_date_provider"
  | "subjects_provider"
  | "page_count_provider"
  | "cover_fail_reason"
  | "description_fail_reason"
  | "publisher_fail_reason"
  | "published_date_fail_reason"
  | "subjects_fail_reason"
  | "page_count_fail_reason"
> & {
  cover_storage_backend: CoverStorageBackend | null;
  description_provider: DescriptionProvider | null;
  cover_source: CoverSource | null;
  // Per-field provider overrides — the generated row widens these to
  // `string | null` because the DB CHECK constraint isn't visible to the
  // gen:types extractor. cover_source carries the cover provider; the
  // four below carry the other tracked-field providers. description
  // provider stays on the existing DescriptionProvider alias since it
  // predates the refit.
  publisher_provider: FieldProvider | null;
  published_date_provider: FieldProvider | null;
  subjects_provider: FieldProvider | null;
  page_count_provider: FieldProvider | null;
  // Per-field fail buckets — likewise narrowed back to the literal union
  // the DB CHECK enforces. Drives the TTL ladder in shouldAttempt() and
  // _field_replay_due().
  cover_fail_reason: FailReason | null;
  description_fail_reason: FailReason | null;
  publisher_fail_reason: FailReason | null;
  published_date_fail_reason: FailReason | null;
  subjects_fail_reason: FailReason | null;
  page_count_fail_reason: FailReason | null;
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

// ─── Catalog refit (2026-05-27) shared types ───────────────────────────────
//
// Per-field state bucket literals. Drives the TTL ladder in
// _field_replay_due() / shouldAttempt(): rate_limited + transient_error
// retry in 1h, provider_disabled in 24h, provider_empty_field in 30d,
// provider_no_data + exhausted in 90d. CHECK-constrained at the DB level
// per migration 20260527000001.
//
// Re-exported from `./tracked-fields` so the operator CLI under
// `scripts/data/` can pull the canonical literal union via relative path
// without dragging $lib resolution through tsx.
export type { FailReason } from "$lib/catalog/tracked-fields";
export { FAIL_REASONS } from "$lib/catalog/tracked-fields";

// Provider provenance for textual fields (publisher / published_date /
// subjects / page_count). Cover uses the narrower CoverSource union;
// description uses DescriptionProvider (same four literals).
export type FieldProvider =
  | "openlibrary"
  | "google_books"
  | "itunes"
  | "manual";

// Fields the per-field walker tracks state for. Re-exported from
// `./tracked-fields` so the operator CLI under `scripts/data/` can pull
// the canonical literal union without $lib resolution.
export type { TrackedField } from "$lib/catalog/tracked-fields";
export { TRACKED_FIELDS } from "$lib/catalog/tracked-fields";

// Optional context the caller hands to resolveIsbn so the resolver can
// reconcile a previously-TA-keyed row to ISBN on cold-resolve (PR3).
// Both fields are required together for promote-on-resolve to fire;
// undefined ctx keeps the existing no-promote behavior.
export interface ResolveCtx {
  title?: string;
  author?: string;
}
