import { describe, expect, it } from "vitest";
import {
  buildPendingRow,
  type BuildPendingRowArgs,
  type CoverResolution,
  type ResolveAuditFields,
} from "$lib/server/catalog/fetcher";
import type { ChainResult } from "$lib/server/catalog/chain";
import type {
  BookCatalogRowFields,
  CatalogMetadata,
  TrackedField,
} from "$lib/server/catalog/types";

const NOW = new Date("2026-05-02T00:00:00Z");

const NULL_AUDIT: ResolveAuditFields = {
  gb_pdf_available: null,
  gb_viewability: null,
  gb_image_link_tiers: null,
  cover_aspect: null,
  cover_bytes_per_pixel: null,
};

const EMPTY_METADATA: CatalogMetadata = {};

function baseArgs(
  overrides: Partial<BuildPendingRowArgs> = {},
): BuildPendingRowArgs {
  return {
    isbn: "9780000000000",
    normalizedTitleAuthor: null,
    cover: null,
    coverStateInUpsert: false,
    coverFailReason: null,
    metadata: EMPTY_METADATA,
    existing: null,
    fieldResults: {},
    audit: NULL_AUDIT,
    pending: false,
    now: NOW,
    ...overrides,
  };
}

describe("buildPendingRow — cover state dual-shape", () => {
  it("cover === null + coverStateInUpsert=true writes cover_attempted_at + cover_fail_reason in pending row", () => {
    const row = buildPendingRow(
      baseArgs({
        coverStateInUpsert: true,
        coverFailReason: "exhausted",
        existing: { cover_attempts: 1 } as Partial<BookCatalogRowFields>,
      }),
    );
    expect(row.cover_attempted_at).toBe(NOW.toISOString());
    expect(row.cover_fail_reason).toBe("exhausted");
    expect(row.cover_attempts).toBe(2);
    expect(row.pending_storage).toBe(false);
    expect(row.storage_path).toBeNull();
  });

  it("cover !== null + coverStateInUpsert=false leaves pending-row cover state null", () => {
    // Positive cover path: pending row keeps state null; finalize UPDATE
    // (run after upload) writes attempted_at + fail_reason=null + attempts.
    const cover: CoverResolution = {
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/jpeg",
      width: 1200,
      source: "google_books",
    } as CoverResolution;
    const row = buildPendingRow(
      baseArgs({
        cover,
        coverStateInUpsert: false,
        coverFailReason: null,
        pending: true,
      }),
    );
    expect(row.cover_attempted_at).toBeNull();
    expect(row.cover_fail_reason).toBeNull();
    expect(row.cover_attempts).toBe(0);
    expect(row.pending_storage).toBe(true);
    expect(row.cover_source).toBe("google_books");
  });

  it("walker-skipped fields (no fieldResults entry) write attempts=0 + null state", () => {
    const row = buildPendingRow(baseArgs({}));
    for (const field of [
      "description",
      "publisher",
      "published_date",
      "subjects",
      "page_count",
    ] as TrackedField[]) {
      expect(row[`${field}_attempted_at`]).toBeNull();
      expect(row[`${field}_fail_reason`]).toBeNull();
      expect(row[`${field}_attempts`]).toBe(0);
    }
  });

  it("walker-success on description writes value + provider + null fail_reason + attempts+1", () => {
    const description: ChainResult<string> = {
      value: "from openlibrary",
      provider: "openlibrary",
      fail_reason: null,
    };
    const row = buildPendingRow(
      baseArgs({
        fieldResults: { description },
        existing: {
          description_attempts: 0,
        } as Partial<BookCatalogRowFields>,
      }),
    );
    expect(row.description).toBe("from openlibrary");
    expect(row.description_provider).toBe("openlibrary");
    expect(row.description_attempted_at).toBe(NOW.toISOString());
    expect(row.description_fail_reason).toBeNull();
    expect(row.description_attempts).toBe(1);
  });

  it("walker-failure on publisher writes null value + null provider + fail_reason + attempts+1", () => {
    const publisher: ChainResult<string> = {
      value: null,
      provider: null,
      fail_reason: "rate_limited",
    };
    const row = buildPendingRow(
      baseArgs({
        fieldResults: { publisher },
        existing: {
          publisher_attempts: 4,
        } as Partial<BookCatalogRowFields>,
      }),
    );
    expect(row.publisher).toBeNull();
    expect(row.publisher_provider).toBeNull();
    expect(row.publisher_fail_reason).toBe("rate_limited");
    expect(row.publisher_attempts).toBe(5);
  });

  it("subjects walker writes string[] value when success", () => {
    const subjects: ChainResult<string[]> = {
      value: ["fiction", "novels"],
      provider: "google_books",
      fail_reason: null,
    };
    const row = buildPendingRow(baseArgs({ fieldResults: { subjects } }));
    expect(row.subjects).toEqual(["fiction", "novels"]);
    expect(row.subjects_provider).toBe("google_books");
  });

  it("page_count walker writes number value when success", () => {
    const page_count: ChainResult<number> = {
      value: 250,
      provider: "openlibrary",
      fail_reason: null,
    };
    const row = buildPendingRow(baseArgs({ fieldResults: { page_count } }));
    expect(row.page_count).toBe(250);
    expect(row.page_count_provider).toBe("openlibrary");
  });
});

describe("buildPendingRow — key columns", () => {
  it("ISBN-keyed payload writes isbn + omits normalized_title_author key", () => {
    const row = buildPendingRow(baseArgs());
    expect(row.isbn).toBe("9780000000000");
    expect(row).not.toHaveProperty("normalized_title_author");
  });

  it("TA-keyed payload writes normalized_title_author + isbn=null", () => {
    const row = buildPendingRow(
      baseArgs({
        isbn: null,
        normalizedTitleAuthor: "ruth|kate-riley",
      }),
    );
    expect(row.isbn).toBeNull();
    expect(row.normalized_title_author).toBe("ruth|kate-riley");
  });
});

describe("buildPendingRow — metadata flow", () => {
  it("non-tracked metadata (title, author, isbn_10, language, etc.) flows through", () => {
    const metadata: CatalogMetadata = {
      title: "The Great Gatsby",
      author: "F. Scott Fitzgerald",
      isbn_10: "0743273567",
      language: "en",
      series_name: "Modern Library",
      series_position: 1,
      source_url: "https://openlibrary.org/works/OL1W",
      description_raw: "Raw GB blurb",
    };
    const row = buildPendingRow(baseArgs({ metadata }));
    expect(row.title).toBe("The Great Gatsby");
    expect(row.author).toBe("F. Scott Fitzgerald");
    expect(row.isbn_10).toBe("0743273567");
    expect(row.language).toBe("en");
    expect(row.series_name).toBe("Modern Library");
    expect(row.series_position).toBe(1);
    expect(row.source_url).toBe("https://openlibrary.org/works/OL1W");
    expect(row.description_raw).toBe("Raw GB blurb");
  });

  it("cover bytes-source ids flow through (openlibrary_cover_id + google_volume_id)", () => {
    const cover: CoverResolution = {
      bytes: new Uint8Array(),
      mime: "image/jpeg",
      width: 1200,
      source: "openlibrary_isbn",
      openLibraryCoverId: 12345,
    } as CoverResolution;
    const row = buildPendingRow(baseArgs({ cover, pending: true }));
    expect(row.cover_source).toBe("openlibrary_isbn");
    expect(row.openlibrary_cover_id).toBe(12345);
  });

  it("attempt_count increments from existing.attempt_count", () => {
    const row = buildPendingRow(
      baseArgs({
        existing: { attempt_count: 3 } as Partial<BookCatalogRowFields>,
      }),
    );
    expect(row.attempt_count).toBe(4);
  });

  it("attempt_count starts at 1 on new row (existing null)", () => {
    const row = buildPendingRow(baseArgs({ existing: null }));
    expect(row.attempt_count).toBe(1);
  });
});
