import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdmin, getSql, shutdown } from "../helpers";

// Verifies the five audit columns added in 20260518000001
// (`gb_pdf_available`, `gb_viewability`, `gb_image_link_tiers`,
// `cover_aspect`, `cover_bytes_per_pixel`) are accepted by the upsert
// RPCs and round-trip to the row.
//
// Numeric audit columns use NUMERIC(5,3) / NUMERIC(7,5) and Postgres
// returns them as strings via postgres-js — `Number()` + `toBeCloseTo`
// covers the precision contract.
//
// The book_catalog_storage_consistency CHECK constraint requires
// `storage_path` and `cover_storage_backend` to both be NULL or both
// non-null, so the negative-cache cases (1 and 3) leave both null while
// case 2 sets both. See:
//   docs/superpowers/plans/2026-05-18-catalog-cover-chain-hardening.md

const SKIP = !process.env.INTEGRATION;

const TEST_ISBN_NEGATIVE = "9789999999994";
const TEST_ISBN_NUMERIC = "9789999999995";
const TEST_KEY_TITLE_AUTHOR = "audit-fixture/test-9789999999990003";

describe.skipIf(SKIP)("book_catalog audit columns persist via RPCs", () => {
  const sql = getSql();

  beforeAll(async () => {
    await sql`DELETE FROM book_catalog WHERE isbn IN (${TEST_ISBN_NEGATIVE}, ${TEST_ISBN_NUMERIC})`;
    await sql`DELETE FROM book_catalog WHERE normalized_title_author = ${TEST_KEY_TITLE_AUTHOR}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM book_catalog WHERE isbn IN (${TEST_ISBN_NEGATIVE}, ${TEST_ISBN_NUMERIC})`;
    await sql`DELETE FROM book_catalog WHERE normalized_title_author = ${TEST_KEY_TITLE_AUTHOR}`;
    await shutdown();
  });

  it("upsert_book_catalog_by_isbn persists negative-cache audit fields", async () => {
    const admin = getAdmin();
    const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
      p_row: {
        isbn: TEST_ISBN_NEGATIVE,
        title: "Negative Cache Audit Book",
        author: "Test Author",
        storage_path: null,
        cover_storage_backend: null,
        gb_pdf_available: false,
        gb_viewability: "PARTIAL",
        gb_image_link_tiers: ["extraLarge", "large", "medium", "thumbnail"],
        cover_aspect: null,
        cover_bytes_per_pixel: null,
        last_attempted_at: new Date().toISOString(),
        attempt_count: 1,
      },
    });
    expect(error).toBeNull();

    const rows = await sql<
      {
        gb_pdf_available: boolean | null;
        gb_viewability: string | null;
        gb_image_link_tiers: string[] | null;
        cover_aspect: string | null;
        cover_bytes_per_pixel: string | null;
      }[]
    >`
      SELECT gb_pdf_available, gb_viewability, gb_image_link_tiers,
             cover_aspect, cover_bytes_per_pixel
        FROM book_catalog
       WHERE isbn = ${TEST_ISBN_NEGATIVE}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].gb_pdf_available).toBe(false);
    expect(rows[0].gb_viewability).toBe("PARTIAL");
    expect(rows[0].gb_image_link_tiers).toEqual([
      "extraLarge",
      "large",
      "medium",
      "thumbnail",
    ]);
    expect(rows[0].cover_aspect).toBeNull();
    expect(rows[0].cover_bytes_per_pixel).toBeNull();
  });

  it("upsert_book_catalog_by_isbn persists numeric audit fields on accepted rows", async () => {
    const admin = getAdmin();
    const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
      p_row: {
        isbn: TEST_ISBN_NUMERIC,
        title: "Numeric Audit Book",
        author: "Test Author",
        storage_path: "deadbeef",
        cover_storage_backend: "cloudflare-images",
        // image_sha256 CHECK constraint: must match ^[0-9a-f]{64}$
        image_sha256:
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        cover_source: "google_books",
        cover_max_width: 1200,
        gb_pdf_available: true,
        gb_viewability: "PARTIAL",
        gb_image_link_tiers: ["extraLarge"],
        cover_aspect: 1.5,
        cover_bytes_per_pixel: 0.23456,
        last_attempted_at: new Date().toISOString(),
        attempt_count: 1,
      },
    });
    expect(error).toBeNull();

    const rows = await sql<
      {
        gb_pdf_available: boolean | null;
        gb_viewability: string | null;
        gb_image_link_tiers: string[] | null;
        cover_aspect: string | null;
        cover_bytes_per_pixel: string | null;
        cover_max_width: number | null;
      }[]
    >`
      SELECT gb_pdf_available, gb_viewability, gb_image_link_tiers,
             cover_aspect, cover_bytes_per_pixel, cover_max_width
        FROM book_catalog
       WHERE isbn = ${TEST_ISBN_NUMERIC}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].gb_pdf_available).toBe(true);
    expect(rows[0].gb_viewability).toBe("PARTIAL");
    expect(rows[0].gb_image_link_tiers).toEqual(["extraLarge"]);
    expect(rows[0].cover_max_width).toBe(1200);
    // postgres-js returns NUMERIC as string — coerce for comparison.
    expect(rows[0].cover_aspect).not.toBeNull();
    expect(rows[0].cover_bytes_per_pixel).not.toBeNull();
    expect(Number(rows[0].cover_aspect)).toBeCloseTo(1.5, 3);
    expect(Number(rows[0].cover_bytes_per_pixel)).toBeCloseTo(0.23456, 5);
  });

  it("upsert_book_catalog_by_title_author persists audit fields", async () => {
    const admin = getAdmin();
    const { error } = await admin.rpc("upsert_book_catalog_by_title_author", {
      p_row: {
        normalized_title_author: TEST_KEY_TITLE_AUTHOR,
        isbn: null,
        title: "Title-Author Audit Book",
        author: "Test Author",
        storage_path: null,
        cover_storage_backend: null,
        gb_pdf_available: false,
        gb_viewability: "PARTIAL",
        gb_image_link_tiers: ["extraLarge", "large", "medium", "thumbnail"],
        cover_aspect: null,
        cover_bytes_per_pixel: null,
        last_attempted_at: new Date().toISOString(),
        attempt_count: 1,
      },
    });
    expect(error).toBeNull();

    const rows = await sql<
      {
        gb_pdf_available: boolean | null;
        gb_viewability: string | null;
        gb_image_link_tiers: string[] | null;
      }[]
    >`
      SELECT gb_pdf_available, gb_viewability, gb_image_link_tiers
        FROM book_catalog
       WHERE normalized_title_author = ${TEST_KEY_TITLE_AUTHOR}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].gb_pdf_available).toBe(false);
    expect(rows[0].gb_viewability).toBe("PARTIAL");
    expect(rows[0].gb_image_link_tiers).toEqual([
      "extraLarge",
      "large",
      "medium",
      "thumbnail",
    ]);
  });
});
