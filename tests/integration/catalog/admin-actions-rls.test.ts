import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  asAuthUser,
  getAdmin,
  shutdown,
  createTestUser,
  deleteTestUser,
} from "../helpers";

describe.skipIf(!process.env.INTEGRATION)("catalog_admin_actions RLS", () => {
  let aliceId: string;
  let bobId: string;
  let charlieId: string;
  let catalogId: string;

  beforeEach(async () => {
    const admin = getAdmin();
    await admin.from("catalog_admin_actions").delete().not("id", "is", null);
    await admin.from("book_catalog").delete().not("id", "is", null);

    const alice = await createTestUser("rls-alice");
    const bob = await createTestUser("rls-bob");
    const charlie = await createTestUser("rls-charlie");
    aliceId = alice.id;
    bobId = bob.id;
    charlieId = charlie.id;
    await admin
      .from("profiles")
      .update({ is_admin: true })
      .in("id", [aliceId, bobId]);

    const { data: row } = await admin
      .from("book_catalog")
      .insert({ isbn: "9780000000200", title: "RLS test" })
      .select("id")
      .single();
    catalogId = row!.id;

    await admin.from("catalog_admin_actions").insert([
      {
        admin_user_id: aliceId,
        catalog_id: catalogId,
        isbn: "9780000000200",
        action: "takedown",
        before_jsonb: {},
        after_jsonb: {},
      },
      {
        admin_user_id: bobId,
        catalog_id: catalogId,
        isbn: "9780000000200",
        action: "save_description",
        before_jsonb: {},
        after_jsonb: {},
      },
    ]);
  });

  afterAll(async () => {
    const admin = getAdmin();
    if (aliceId) await deleteTestUser(aliceId).catch(() => undefined);
    if (bobId) await deleteTestUser(bobId).catch(() => undefined);
    if (charlieId) await deleteTestUser(charlieId).catch(() => undefined);
    await admin.from("catalog_admin_actions").delete().not("id", "is", null);
    await admin.from("book_catalog").delete().not("id", "is", null);
    await shutdown();
  });

  it("admin reads own audit rows; cannot read peer admin's", async () => {
    const visibleToAlice = await asAuthUser(aliceId, async (txn) => {
      return txn<
        { admin_user_id: string }[]
      >`SELECT admin_user_id FROM catalog_admin_actions`;
    });
    expect(visibleToAlice).toHaveLength(1);
    expect(visibleToAlice[0].admin_user_id).toBe(aliceId);
  });

  it("non-admin (is_admin=false) reads zero rows even when they own none", async () => {
    const visibleToCharlie = await asAuthUser(charlieId, async (txn) => {
      return txn`SELECT * FROM catalog_admin_actions`;
    });
    expect(visibleToCharlie).toHaveLength(0);
  });

  it("admin sees only their own row when peer also has one", async () => {
    const visibleToBob = await asAuthUser(bobId, async (txn) => {
      return txn<
        { admin_user_id: string; action: string }[]
      >`SELECT admin_user_id, action FROM catalog_admin_actions`;
    });
    expect(visibleToBob).toHaveLength(1);
    expect(visibleToBob[0].admin_user_id).toBe(bobId);
    expect(visibleToBob[0].action).toBe("save_description");
  });

  it("admin-client (service_role) sees all rows — sanity check seed", async () => {
    const { data: rows } = await getAdmin()
      .from("catalog_admin_actions")
      .select("admin_user_id");
    expect(rows?.length).toBe(2);
  });

  // Write-denial sweep — RLS denies by default when no INSERT/UPDATE/DELETE
  // policy exists, but a future "let admins manage their own actions" diff
  // could accidentally add an over-broad ALL policy. These assertions
  // backstop the table's intended posture: authenticated callers cannot
  // touch catalog_admin_actions at all; only service_role writes.
  it("admin cannot INSERT a catalog_admin_actions row directly", async () => {
    await expect(
      asAuthUser(aliceId, async (txn) => {
        await txn`
          INSERT INTO catalog_admin_actions
            (admin_user_id, catalog_id, isbn, action, before_jsonb, after_jsonb)
          VALUES
            (${aliceId}, ${catalogId}, ${"9780000000200"}, ${"takedown"}, ${"{}"}::jsonb, ${"{}"}::jsonb)
        `;
      }),
    ).rejects.toThrow(/new row violates row-level security/i);
  });

  it("admin cannot UPDATE a catalog_admin_actions row directly", async () => {
    await asAuthUser(aliceId, async (txn) => {
      const result = await txn`
        UPDATE catalog_admin_actions SET action = 'takedown' WHERE admin_user_id = ${aliceId}
      `;
      // RLS USING denies the row from the UPDATE's row set → 0 rows
      // updated, no error. Defence-in-depth: assert the row stayed
      // unchanged via the service_role admin client.
      expect(result.count).toBe(0);
    });
    const { data: row } = await getAdmin()
      .from("catalog_admin_actions")
      .select("action")
      .eq("admin_user_id", aliceId)
      .single();
    expect(row?.action).toBe("takedown"); // unchanged from seed
  });

  it("admin cannot DELETE a catalog_admin_actions row directly", async () => {
    await asAuthUser(aliceId, async (txn) => {
      const result = await txn`
        DELETE FROM catalog_admin_actions WHERE admin_user_id = ${aliceId}
      `;
      expect(result.count).toBe(0);
    });
    const { data: rows } = await getAdmin()
      .from("catalog_admin_actions")
      .select("id")
      .eq("admin_user_id", aliceId);
    expect(rows?.length).toBe(1); // still there
  });
});
