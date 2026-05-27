import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getAdmin, shutdown } from "../helpers";

describe.skipIf(!process.env.INTEGRATION)("promote_ta_to_isbn RPC", () => {
  let admin: ReturnType<typeof getAdmin>;

  beforeEach(async () => {
    admin = getAdmin();
    await admin.from("book_catalog").delete().not("id", "is", null);
  });

  afterAll(async () => {
    await shutdown();
  });

  it("promotes a TA-keyed row to ISBN-keyed", async () => {
    await admin.from("book_catalog").insert({
      isbn: null,
      normalized_title_author: "ruth|kate-riley",
      title: "Ruth",
      author: "Kate Riley",
    });

    const { data: promoted, error } = await admin.rpc("promote_ta_to_isbn", {
      p_isbn: "9780000000001",
      p_ta_key: "ruth|kate-riley",
    });

    expect(error).toBeNull();
    expect(promoted).toBe(true);

    const { data: row } = await admin
      .from("book_catalog")
      .select("isbn, normalized_title_author")
      .eq("normalized_title_author", "ruth|kate-riley")
      .single();
    expect(row?.isbn).toBe("9780000000001");
  });

  it("returns false when no TA row matches", async () => {
    const { data: promoted } = await admin.rpc("promote_ta_to_isbn", {
      p_isbn: "9780000000002",
      p_ta_key: "nothing-matches-this-key",
    });
    expect(promoted).toBe(false);
  });

  it("returns false on unique_violation when ISBN row already exists", async () => {
    await admin.from("book_catalog").insert([
      { isbn: "9780000000003", title: "Existing ISBN row" },
      {
        isbn: null,
        normalized_title_author: "duplicate|same-author",
        title: "Duplicate physical book",
        author: "Same Author",
      },
    ]);

    const { data: promoted, error } = await admin.rpc("promote_ta_to_isbn", {
      p_isbn: "9780000000003",
      p_ta_key: "duplicate|same-author",
    });

    expect(error).toBeNull();
    expect(promoted).toBe(false);

    // TA row stays orphaned — caller's responsibility to handle.
    const { data: taRow } = await admin
      .from("book_catalog")
      .select("isbn")
      .eq("normalized_title_author", "duplicate|same-author")
      .single();
    expect(taRow?.isbn).toBeNull();
  });
});
