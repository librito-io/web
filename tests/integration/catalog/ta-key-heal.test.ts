import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getAdmin, shutdown } from "../helpers";

// Behaviour-level guard for issue #489 Fix B at the DB layer. The resolver
// (resolveTitleAuthor) cannot be imported into the pure-Node integration
// runner ($env/static/public; see memory feedback_lib_alias_integration_config),
// so this test drives the exact two-step DB sequence Fix B performs against
// real Postgres — proving the consequences the chainable-mock unit tests in
// `tests/lib/catalog/fetcher.test.ts` cannot observe:
//
//   HEAL (canonical key free): rename the drifted row's key to the canonical
//     value, then upsert keyed on the canonical value → the renamed row is
//     updated in place → exactly one row.
//
//   COLLISION (canonical key held by another row): renaming into it must be
//     blocked by the partial-unique index, so Fix B's pre-check skips the
//     rename and both rows survive untouched (the merge is the sweeper's job).

const CANON = "1984 adaptation|michael dean george orwell";
const STORED = "1984|george orwell";

describe.skipIf(!process.env.INTEGRATION)(
  "TA key heal / collision at the DB layer (#489 Fix B)",
  () => {
    let admin: ReturnType<typeof getAdmin>;

    beforeEach(async () => {
      admin = getAdmin();
      await admin.from("book_catalog").delete().not("id", "is", null);
    });

    afterAll(async () => {
      await shutdown();
    });

    it("heals: rename drifted key to canonical, then upsert-by-canonical updates in place (1 row)", async () => {
      const { data: seed, error: seedErr } = await admin
        .from("book_catalog")
        .insert({
          normalized_title_author: STORED, // drifted from title/author
          title: "1984 (adaptation)",
          author: "Michael Dean, George Orwell",
          pending_storage: false,
        })
        .select("id")
        .single();
      if (seedErr) throw seedErr;
      const seededId = seed!.id as string;

      // Step 1: heal-rename (canonical key is free).
      const { error: renameErr } = await admin
        .from("book_catalog")
        .update({ normalized_title_author: CANON })
        .is("isbn", null)
        .eq("normalized_title_author", STORED);
      expect(renameErr).toBeNull();

      // Step 2: upsert keyed on the canonical value → hits the renamed row.
      const { error: rpcErr } = await admin.rpc(
        "upsert_book_catalog_by_title_author",
        {
          p_row: {
            normalized_title_author: CANON,
            title: "1984 (adaptation)",
            author: "Michael Dean, George Orwell",
            pending_storage: true,
          },
        },
      );
      if (rpcErr) throw rpcErr;

      const { data: rows } = await admin
        .from("book_catalog")
        .select("id, normalized_title_author, pending_storage")
        .is("isbn", null);
      expect(rows).toHaveLength(1);
      expect(rows![0].id).toBe(seededId);
      expect(rows![0].normalized_title_author).toBe(CANON); // self-healed
      expect(rows![0].pending_storage).toBe(true); // updated in place
    });

    it("collision: renaming a drifted key into one already held is blocked by the unique index (both rows survive)", async () => {
      // Row X (drifted) + row Y (already holds the canonical key).
      const { error: seedErr } = await admin.from("book_catalog").insert([
        {
          normalized_title_author: STORED,
          title: "1984 (adaptation)",
          author: "Michael Dean, George Orwell",
          pending_storage: false,
        },
        {
          normalized_title_author: CANON,
          title: "1984 (adaptation)",
          author: "Michael Dean, George Orwell",
          pending_storage: false,
        },
      ]);
      if (seedErr) throw seedErr;

      // The rename Fix B would attempt — must be rejected by the partial
      // unique index (this is why Fix B's pre-check defers instead).
      const { error: renameErr } = await admin
        .from("book_catalog")
        .update({ normalized_title_author: CANON })
        .is("isbn", null)
        .eq("normalized_title_author", STORED);
      expect(renameErr).not.toBeNull();
      expect(renameErr!.code).toBe("23505"); // unique_violation

      // Both rows survive untouched.
      const { data: rows } = await admin
        .from("book_catalog")
        .select("normalized_title_author")
        .is("isbn", null);
      expect(rows).toHaveLength(2);
      const keys = (rows ?? []).map((r) => r.normalized_title_author).sort();
      expect(keys).toEqual([CANON, STORED].sort());
    });
  },
);
