import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdmin, getSql, shutdown } from "./helpers";

// Regression guard for issue #214: `upsert_book_catalog_by_isbn` threw
// SQLSTATE 22023 ("cannot extract elements from a scalar") whenever
// `p_row->'subjects'` arrived as JSON null. The resolver always emits
// the key with `metadata.subjects ?? null`, so every ISBN where Open
// Library has no subjects (common for new or niche books) silently
// orphaned the row — CF Images upload succeeded, RPC threw,
// runInBackground swallowed the throw, `book_catalog` row never wrote.
//
// The fix (20260517000002) switches the guard from key-presence
// (`p_row ? 'subjects'`) to value-shape (`jsonb_typeof(...) = 'array'`).
// These tests pin that contract at the DB layer so a future re-declare
// of the RPC cannot regress it without flipping a test.

const SKIP = !process.env.INTEGRATION;

const TEST_ISBN_NULL = "9789999999991";
const TEST_ISBN_ARRAY = "9789999999992";
const TEST_ISBN_MISSING = "9789999999993";

describe.skipIf(SKIP)(
  "upsert_book_catalog_by_isbn subjects scalar guard",
  () => {
    const sql = getSql();

    beforeAll(async () => {
      await sql`DELETE FROM book_catalog WHERE isbn IN (${TEST_ISBN_NULL}, ${TEST_ISBN_ARRAY}, ${TEST_ISBN_MISSING})`;
    });

    afterAll(async () => {
      await sql`DELETE FROM book_catalog WHERE isbn IN (${TEST_ISBN_NULL}, ${TEST_ISBN_ARRAY}, ${TEST_ISBN_MISSING})`;
      await shutdown();
    });

    it("accepts subjects: null (resolver path with no OL subjects)", async () => {
      const admin = getAdmin();
      const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: TEST_ISBN_NULL,
          title: "Null Subjects Book",
          author: "Test Author",
          subjects: null,
          last_attempted_at: new Date().toISOString(),
          attempt_count: 1,
        },
      });
      expect(error).toBeNull();

      const rows = await sql<{ subjects: string[] | null }[]>`
        SELECT subjects FROM book_catalog WHERE isbn = ${TEST_ISBN_NULL}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].subjects).toBeNull();
    });

    it("round-trips subjects array when populated", async () => {
      const admin = getAdmin();
      const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: TEST_ISBN_ARRAY,
          title: "Array Subjects Book",
          author: "Test Author",
          subjects: ["fiction", "thriller"],
          last_attempted_at: new Date().toISOString(),
          attempt_count: 1,
        },
      });
      expect(error).toBeNull();

      const rows = await sql<{ subjects: string[] | null }[]>`
        SELECT subjects FROM book_catalog WHERE isbn = ${TEST_ISBN_ARRAY}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].subjects).toEqual(["fiction", "thriller"]);
    });

    it("accepts subjects key entirely absent", async () => {
      const admin = getAdmin();
      const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: TEST_ISBN_MISSING,
          title: "Missing Subjects Key Book",
          author: "Test Author",
          last_attempted_at: new Date().toISOString(),
          attempt_count: 1,
        },
      });
      expect(error).toBeNull();

      const rows = await sql<{ subjects: string[] | null }[]>`
        SELECT subjects FROM book_catalog WHERE isbn = ${TEST_ISBN_MISSING}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].subjects).toBeNull();
    });
  },
);
