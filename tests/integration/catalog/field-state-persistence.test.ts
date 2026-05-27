import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getAdmin, shutdown } from "../helpers";

describe.skipIf(!process.env.INTEGRATION)(
  "book_catalog field-state upsert (migration 20260527000006)",
  () => {
    let admin: ReturnType<typeof getAdmin>;

    beforeEach(async () => {
      admin = getAdmin();
      await admin.from("book_catalog").delete().not("id", "is", null);
    });

    afterAll(async () => {
      await shutdown();
    });

    it("INSERT writes per-field state columns through upsert_by_isbn", async () => {
      const now = new Date().toISOString();
      const { error } = await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: "9780000000300",
          description: "got from gb",
          description_provider: "google_books",
          description_attempted_at: now,
          description_fail_reason: null,
          description_attempts: 1,
          publisher_attempted_at: now,
          publisher_fail_reason: "rate_limited",
          publisher_attempts: 1,
          subjects_provider: "openlibrary",
          subjects: ["fiction"],
          subjects_attempted_at: now,
          subjects_attempts: 1,
        },
      });
      expect(error).toBeNull();

      const { data: row } = await admin
        .from("book_catalog")
        .select(
          "description, description_provider, description_attempted_at, " +
            "description_fail_reason, description_attempts, " +
            "publisher, publisher_attempted_at, publisher_fail_reason, publisher_attempts, " +
            "subjects, subjects_provider, subjects_attempted_at, subjects_attempts",
        )
        .eq("isbn", "9780000000300")
        .single();

      expect(row?.description).toBe("got from gb");
      expect(row?.description_provider).toBe("google_books");
      expect(row?.description_fail_reason).toBeNull();
      expect(row?.description_attempts).toBe(1);
      expect(row?.publisher).toBeNull();
      expect(row?.publisher_fail_reason).toBe("rate_limited");
      expect(row?.publisher_attempts).toBe(1);
      expect(row?.subjects).toEqual(["fiction"]);
      expect(row?.subjects_provider).toBe("openlibrary");
      expect(row?.subjects_attempts).toBe(1);
    });

    it("DO UPDATE preserves untouched per-field state via COALESCE", async () => {
      const first = new Date().toISOString();
      await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: "9780000000301",
          publisher: "OL Publisher",
          publisher_provider: "openlibrary",
          publisher_attempted_at: first,
          publisher_attempts: 1,
        },
      });
      const second = new Date(Date.now() + 1000).toISOString();
      await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: "9780000000301",
          description: "added on second pass",
          description_provider: "google_books",
          description_attempted_at: second,
          description_attempts: 1,
        },
      });

      const { data: row } = await admin
        .from("book_catalog")
        .select(
          "publisher, publisher_provider, publisher_attempted_at, publisher_attempts, " +
            "description, description_provider, description_attempted_at, description_attempts",
        )
        .eq("isbn", "9780000000301")
        .single();

      expect(row?.publisher).toBe("OL Publisher");
      expect(row?.publisher_provider).toBe("openlibrary");
      expect(row?.publisher_attempts).toBe(1);
      expect(row?.description).toBe("added on second pass");
      expect(row?.description_provider).toBe("google_books");
      expect(row?.description_attempts).toBe(1);
    });

    it("DO UPDATE *_attempts uses GREATEST so concurrent resolves never lose count", async () => {
      await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: "9780000000302",
          description_attempted_at: new Date().toISOString(),
          description_attempts: 3,
        },
      });
      // Concurrent resolve sees attempts=2 (older snapshot) and writes 3.
      // GREATEST(3, 3) = 3 → no decrement.
      await admin.rpc("upsert_book_catalog_by_isbn", {
        p_row: {
          isbn: "9780000000302",
          description_attempted_at: new Date().toISOString(),
          description_attempts: 3,
        },
      });
      const { data: row } = await admin
        .from("book_catalog")
        .select("description_attempts")
        .eq("isbn", "9780000000302")
        .single();
      expect(row?.description_attempts).toBe(3);
    });

    it("upsert_by_title_author writes new state columns + the TA-side textual columns", async () => {
      const now = new Date().toISOString();
      const { error } = await admin.rpc("upsert_book_catalog_by_title_author", {
        p_row: {
          normalized_title_author: "field-state-ta|author",
          title: "Field State TA",
          author: "Author",
          publisher: "TA Publisher",
          publisher_provider: "google_books",
          publisher_attempted_at: now,
          publisher_attempts: 1,
          subjects: ["fiction", "literary"],
          subjects_provider: "google_books",
          subjects_attempted_at: now,
          subjects_attempts: 1,
        },
      });
      expect(error).toBeNull();

      const { data: row } = await admin
        .from("book_catalog")
        .select(
          "publisher, publisher_provider, publisher_attempts, " +
            "subjects, subjects_provider, subjects_attempts",
        )
        .eq("normalized_title_author", "field-state-ta|author")
        .is("isbn", null)
        .single();

      expect(row?.publisher).toBe("TA Publisher");
      expect(row?.publisher_provider).toBe("google_books");
      expect(row?.publisher_attempts).toBe(1);
      expect(row?.subjects).toEqual(["fiction", "literary"]);
      expect(row?.subjects_provider).toBe("google_books");
      expect(row?.subjects_attempts).toBe(1);
    });
  },
);
