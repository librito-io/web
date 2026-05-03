import { describe, it, expect } from "vitest";
import {
  hasCoverStorage,
  type BookCatalogRow,
  type BookCatalogRowFields,
  type PositiveBookCatalogRow,
  type NegativeBookCatalogRow,
  type CoverStorageBackend,
} from "../../../src/lib/server/catalog/types";

// Construct minimal positive and negative rows. Cast at the boundary so the
// test focuses on the discriminant-narrowing behaviour of `hasCoverStorage`
// rather than enumerating every BookCatalogRow column. Anything inside the
// `if (hasCoverStorage(row))` branch must compile WITHOUT `!` assertions —
// that is the type-system invariant this test pins down.
function makePositive(): PositiveBookCatalogRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    isbn: "9780000000001",
    storage_path: "ab/cd.jpg",
    cover_storage_backend: "supabase",
    image_sha256: "deadbeef",
    cover_source: "openlibrary_isbn",
    openlibrary_cover_id: 1234,
    google_volume_id: null,
    source_url: null,
    title: "Title",
    author: "Author",
    description: null,
    description_raw: null,
    description_provider: null,
    published_date: null,
    publisher: null,
    page_count: null,
    language: null,
    subjects: null,
    series_name: null,
    series_position: null,
    isbn_10: null,
    normalized_title_author: null,
    fetched_at: "2026-01-01T00:00:00.000Z",
    last_attempted_at: "2026-01-01T00:00:00.000Z",
    attempt_count: 1,
    do_not_refetch_description: false,
  } satisfies PositiveBookCatalogRow;
}

function makeNegative(): NegativeBookCatalogRow {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    isbn: "9780000000002",
    storage_path: null,
    cover_storage_backend: null,
    image_sha256: null,
    cover_source: null,
    openlibrary_cover_id: null,
    google_volume_id: null,
    source_url: null,
    title: null,
    author: null,
    description: null,
    description_raw: null,
    description_provider: null,
    published_date: null,
    publisher: null,
    page_count: null,
    language: null,
    subjects: null,
    series_name: null,
    series_position: null,
    isbn_10: null,
    normalized_title_author: null,
    fetched_at: "2026-01-01T00:00:00.000Z",
    last_attempted_at: "2026-01-01T00:00:00.000Z",
    attempt_count: 1,
    do_not_refetch_description: false,
  } satisfies NegativeBookCatalogRow;
}

describe("hasCoverStorage", () => {
  it("narrows positive row to PositiveBookCatalogRow", () => {
    const row: BookCatalogRow = makePositive();
    expect(hasCoverStorage(row)).toBe(true);
    if (hasCoverStorage(row)) {
      // Type-level assertions: both fields are non-null inside the guard.
      // These lines must compile without `!` — that proves the discriminated
      // union is doing its job.
      const path: string = row.storage_path;
      const backend: CoverStorageBackend = row.cover_storage_backend;
      expect(path).toBe("ab/cd.jpg");
      expect(backend).toBe("supabase");
    }
  });

  it("rejects negative row", () => {
    const row: BookCatalogRow = makeNegative();
    expect(hasCoverStorage(row)).toBe(false);
  });

  it("composes with partial projections (column-subset selects)", () => {
    // Mirrors the real call-site shape: a Partial<BookCatalogRow> coming
    // back from a column-projected supabase select. The guard must narrow
    // structurally without requiring the full row.
    // Use the pre-discriminant `BookCatalogRowFields` shape for partial
    // projections — `Partial<BookCatalogRow>` would distribute into
    // `Partial<Pos> | Partial<Neg>` and reject `string` for `storage_path`
    // on the negative branch.
    const partial: Partial<BookCatalogRowFields> = {
      storage_path: "xy/zw.jpg",
      cover_storage_backend: "cloudflare-images",
      description: "blurb",
    };
    expect(hasCoverStorage(partial)).toBe(true);
    if (hasCoverStorage(partial)) {
      const path: string = partial.storage_path;
      const backend: CoverStorageBackend = partial.cover_storage_backend;
      expect(path).toBe("xy/zw.jpg");
      expect(backend).toBe("cloudflare-images");
    }
  });

  it("returns false when only one side is set (defence-in-depth vs DB CHECK)", () => {
    const halfRow: Partial<BookCatalogRowFields> = {
      storage_path: "only/path.jpg",
      cover_storage_backend: null,
    };
    expect(hasCoverStorage(halfRow)).toBe(false);
  });
});
