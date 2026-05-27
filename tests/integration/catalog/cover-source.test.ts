import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdmin, getSql, shutdown } from "../helpers";

// Behavior-level guard: the cover_max_width migration (20260517000001) added
// the column to book_catalog AND threaded it through both upsert RPCs. This
// suite confirms:
//   - cover_max_width round-trips through upsert_book_catalog_by_isbn
//   - cover_max_width round-trips through upsert_book_catalog_by_title_author
//   - cover_source accepts the new "itunes" literal at the DB layer
//   - ON CONFLICT COALESCE preserves an existing cover_max_width when caller
//     omits it from a subsequent upsert (validates the SET clause)
//
// String-match unit tests can drift from the actual SQL; this catches that.

const SKIP = !process.env.INTEGRATION;

const TEST_ISBN = "9789999999990"; // outside real-ISBN ranges; safe to mutate
const TEST_TA_KEY = "test-cover-source-integration-author";

describe.skipIf(SKIP)(
  "catalog cover_source + cover_max_width persistence",
  () => {
    const sql = getSql();

    beforeAll(async () => {
      // Clean any stale rows from a prior aborted run.
      await sql`DELETE FROM book_catalog WHERE isbn = ${TEST_ISBN} OR normalized_title_author = ${TEST_TA_KEY}`;
    });

    afterAll(async () => {
      await sql`DELETE FROM book_catalog WHERE isbn = ${TEST_ISBN} OR normalized_title_author = ${TEST_TA_KEY}`;
      await shutdown();
    });

    it("upsert_book_catalog_by_isbn accepts cover_source='itunes' and cover_max_width", async () => {
      const admin = getAdmin();
      const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: TEST_ISBN,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "cloudflare-images",
          image_sha256:
            "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1230",
          cover_source: "itunes",
          cover_max_width: 1400,
          last_attempted_at: new Date().toISOString(),
          fetched_at: new Date().toISOString(),
          attempt_count: 1,
        },
      });
      expect(error).toBeNull();

      const rows = await sql<
        { cover_source: string; cover_max_width: number }[]
      >`
      SELECT cover_source, cover_max_width
        FROM book_catalog
       WHERE isbn = ${TEST_ISBN}
    `;
      expect(rows).toHaveLength(1);
      expect(rows[0].cover_source).toBe("itunes");
      expect(rows[0].cover_max_width).toBe(1400);
    });

    it("upsert_book_catalog_by_isbn preserves cover_max_width via COALESCE when omitted on conflict", async () => {
      // The seed row above has cover_max_width=1400. Re-upsert with cover_max_width
      // omitted from p_row (which arrives as NULL on the EXCLUDED side); the SET
      // clause's COALESCE should preserve the prior 1400.
      const admin = getAdmin();
      const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: TEST_ISBN,
          title: "Updated Title",
          last_attempted_at: new Date().toISOString(),
          attempt_count: 2,
        },
      });
      expect(error).toBeNull();

      const rows = await sql<{ cover_max_width: number; title: string }[]>`
      SELECT cover_max_width, title
        FROM book_catalog
       WHERE isbn = ${TEST_ISBN}
    `;
      expect(rows[0].cover_max_width).toBe(1400);
      expect(rows[0].title).toBe("Updated Title");
    });

    it("upsert_book_catalog_by_title_author accepts cover_max_width", async () => {
      const admin = getAdmin();
      const { error } = await admin.rpc("upsert_book_catalog_by_title_author", {
        p_row: {
          normalized_title_author: TEST_TA_KEY,
          storage_path: "ef/gh.jpg",
          cover_storage_backend: "cloudflare-images",
          image_sha256:
            "ef015678ef015678ef015678ef015678ef015678ef015678ef015678ef015678",
          cover_source: "openlibrary_search_title",
          cover_max_width: 600,
          last_attempted_at: new Date().toISOString(),
          fetched_at: new Date().toISOString(),
          attempt_count: 1,
        },
      });
      expect(error).toBeNull();

      const rows = await sql<
        { cover_source: string; cover_max_width: number }[]
      >`
      SELECT cover_source, cover_max_width
        FROM book_catalog
       WHERE normalized_title_author = ${TEST_TA_KEY}
         AND isbn IS NULL
    `;
      expect(rows).toHaveLength(1);
      expect(rows[0].cover_source).toBe("openlibrary_search_title");
      expect(rows[0].cover_max_width).toBe(600);
    });
  },
);
