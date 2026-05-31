import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getAdmin, shutdown, createTestUser, deleteTestUser } from "../helpers";

// Integration coverage for the #489 Fix C dedup RPC, merge_ta_catalog_dups.
// The RPC is a dumb, audited, transactional executor: the operator (via the
// admin UI / a TS caller) decides WHICH rows are the same book and which
// survives; the RPC keeps the survivor, deletes the losers, and preserves
// audit history attached to the survivor (loser rows cascade-delete their
// own audit, so the RPC re-parents prior loser audit to the survivor and
// writes one merge audit row per loser).

describe.skipIf(!process.env.INTEGRATION)("merge_ta_catalog_dups RPC", () => {
  let admin: ReturnType<typeof getAdmin>;
  let adminUserId: string;

  beforeEach(async () => {
    admin = getAdmin();
    await admin.from("catalog_admin_actions").delete().not("id", "is", null);
    await admin.from("book_catalog").delete().not("id", "is", null);

    const user = await createTestUser("merge-ta-dups");
    adminUserId = user.id;
    await admin
      .from("profiles")
      .update({ is_admin: true })
      .eq("id", adminUserId);
  });

  afterAll(async () => {
    if (adminUserId) await deleteTestUser(adminUserId).catch(() => undefined);
    await shutdown();
  });

  async function seedTa(
    key: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const { data, error } = await admin
      .from("book_catalog")
      .insert({
        isbn: null,
        normalized_title_author: key,
        title: "1984",
        author: "George Orwell",
        ...extra,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data!.id as string;
  }

  it("deletes losers, keeps survivor, returns count", async () => {
    const survivor = await seedTa("1984|george orwell");
    const loser1 = await seedTa("1984 adaptation|michael dean george orwell");
    const loser2 = await seedTa("nineteen eighty four|george orwell");

    const { data: count, error } = await admin.rpc("merge_ta_catalog_dups", {
      p_admin_user_id: adminUserId,
      p_survivor_id: survivor,
      p_loser_ids: [loser1, loser2],
    });
    expect(error).toBeNull();
    expect(count).toBe(2);

    const { data: rows } = await admin
      .from("book_catalog")
      .select("id")
      .is("isbn", null);
    expect(rows).toHaveLength(1);
    expect(rows![0].id).toBe(survivor);
  });

  it("writes one merge audit row per loser, attached to the survivor, capturing the loser row", async () => {
    const survivor = await seedTa("1984|george orwell");
    const loser = await seedTa("nineteen eighty four|george orwell", {
      cover_source: "openlibrary_work",
    });

    await admin.rpc("merge_ta_catalog_dups", {
      p_admin_user_id: adminUserId,
      p_survivor_id: survivor,
      p_loser_ids: [loser],
    });

    const { data: audits } = await admin
      .from("catalog_admin_actions")
      .select("action, catalog_id, admin_user_id, before_jsonb, after_jsonb")
      .eq("action", "merge_ta_dup");
    expect(audits).toHaveLength(1);
    const a = audits![0];
    // Attached to the survivor (the loser id no longer exists / cascades).
    expect(a.catalog_id).toBe(survivor);
    expect(a.admin_user_id).toBe(adminUserId);
    // before = the deleted loser's full row.
    expect(
      (a.before_jsonb as { normalized_title_author: string })
        .normalized_title_author,
    ).toBe("nineteen eighty four|george orwell");
    expect((a.before_jsonb as { id: string }).id).toBe(loser);
    // after records where it was merged.
    expect((a.after_jsonb as { merged_into: string }).merged_into).toBe(
      survivor,
    );
  });

  it("re-parents a loser's prior admin-action audit to the survivor (history preserved)", async () => {
    const survivor = await seedTa("1984|george orwell");
    const loser = await seedTa("nineteen eighty four|george orwell");

    // A pre-existing audit row on the loser (e.g. an earlier takedown).
    const { data: prior } = await admin
      .from("catalog_admin_actions")
      .insert({
        admin_user_id: adminUserId,
        catalog_id: loser,
        action: "takedown",
        before_jsonb: { note: "old" },
        after_jsonb: { note: "old" },
      })
      .select("id")
      .single();

    await admin.rpc("merge_ta_catalog_dups", {
      p_admin_user_id: adminUserId,
      p_survivor_id: survivor,
      p_loser_ids: [loser],
    });

    // The prior audit row survived (was NOT cascade-deleted) and now points
    // at the survivor.
    const { data: reparented } = await admin
      .from("catalog_admin_actions")
      .select("catalog_id")
      .eq("id", prior!.id as unknown as string)
      .maybeSingle();
    expect(reparented).not.toBeNull();
    expect(reparented!.catalog_id).toBe(survivor);
  });

  it("rejects a non-admin caller (defense-in-depth)", async () => {
    const survivor = await seedTa("1984|george orwell");
    const loser = await seedTa("nineteen eighty four|george orwell");
    const nonAdmin = await createTestUser("merge-non-admin");
    try {
      const { error } = await admin.rpc("merge_ta_catalog_dups", {
        p_admin_user_id: nonAdmin.id,
        p_survivor_id: survivor,
        p_loser_ids: [loser],
      });
      expect(error?.message).toMatch(/is not an admin/i);
      // Nothing deleted.
      const { data: rows } = await admin
        .from("book_catalog")
        .select("id")
        .is("isbn", null);
      expect(rows).toHaveLength(2);
    } finally {
      await deleteTestUser(nonAdmin.id).catch(() => undefined);
    }
  });

  it("rejects when survivor is also in the loser list", async () => {
    const survivor = await seedTa("1984|george orwell");
    const { error } = await admin.rpc("merge_ta_catalog_dups", {
      p_admin_user_id: adminUserId,
      p_survivor_id: survivor,
      p_loser_ids: [survivor],
    });
    expect(error?.message).toMatch(
      /survivor.*loser|cannot merge a row into itself/i,
    );
  });

  it("rejects an empty loser list", async () => {
    const survivor = await seedTa("1984|george orwell");
    const { error } = await admin.rpc("merge_ta_catalog_dups", {
      p_admin_user_id: adminUserId,
      p_survivor_id: survivor,
      p_loser_ids: [],
    });
    expect(error?.message).toMatch(/no loser|empty/i);
  });

  it("rejects when the survivor is ISBN-keyed (TA-dup remedy only)", async () => {
    const { data: isbnRow } = await admin
      .from("book_catalog")
      .insert({ isbn: "9780000000123", title: "1984", author: "George Orwell" })
      .select("id")
      .single();
    const loser = await seedTa("nineteen eighty four|george orwell");
    const { error } = await admin.rpc("merge_ta_catalog_dups", {
      p_admin_user_id: adminUserId,
      p_survivor_id: isbnRow!.id,
      p_loser_ids: [loser],
    });
    expect(error?.message).toMatch(/TA-keyed|isbn/i);
  });
});
