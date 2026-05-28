import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import {
  createTestUser,
  deleteTestUser,
  getAdmin,
  getAnon,
  getSql,
  shutdown,
  type TestUser,
} from "../helpers";

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)("catalog_dlq_archive RLS", () => {
  const sql = getSql();
  let adminUser: TestUser;
  let normalUser: TestUser;
  let archiveRowId: number;

  beforeAll(async () => {
    adminUser = await createTestUser("dlq-admin");
    normalUser = await createTestUser("dlq-normal");

    await getAdmin()
      .from("profiles")
      .update({ is_admin: true })
      .eq("id", adminUser.id);

    const [row] = await sql<{ id: number }[]>`
      INSERT INTO catalog_dlq_archive
        (message_id, payload, first_failed_at, fail_reason)
      VALUES (
        ${"msg-test-" + Date.now()},
        ${JSON.stringify({
          userId: "x",
          item: { kind: "isbn", isbn: "9780000000000" },
        })}::jsonb,
        now(),
        ${"test"}
      )
      RETURNING id
    `;
    archiveRowId = row.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM catalog_dlq_archive WHERE id = ${archiveRowId}`;
    await deleteTestUser(adminUser.id);
    await deleteTestUser(normalUser.id);
    await shutdown();
  });

  // Matches devices-write-surface-rls.test.ts:78-89 — sets jwt claims via
  // set_config(..., true) THEN SET LOCAL ROLE, inside one sql.begin txn.
  // The cast pins postgres-js's `sql.begin` generic which collapses to
  // `never` when chained through a local helper.
  async function asUser<T>(
    user: TestUser,
    work: (txn: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return sql.begin(async (txn) => {
      await txn`SELECT set_config('request.jwt.claims', ${JSON.stringify({
        sub: user.id,
        role: "authenticated",
      })}, true)`;
      await txn`SET LOCAL ROLE authenticated`;
      return work(txn);
    }) as Promise<T>;
  }

  it("anon SELECT returns empty (no SELECT policy for anon)", async () => {
    const { data, error } = await getAnon()
      .from("catalog_dlq_archive")
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("authenticated non-admin SELECT returns empty", async () => {
    const rows = await asUser(
      normalUser,
      (txn) => txn`SELECT id FROM catalog_dlq_archive`,
    );
    expect(rows.length).toBe(0);
  });

  it("authenticated admin SELECT allowed", async () => {
    const rows = await asUser(
      adminUser,
      (txn) =>
        txn<{ id: number }[]>`
          SELECT id FROM catalog_dlq_archive WHERE id = ${archiveRowId}
        `,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(archiveRowId);
  });

  it("service_role SELECT + UPDATE allowed (bypasses RLS)", async () => {
    const admin = getAdmin();
    const { data, error } = await admin
      .from("catalog_dlq_archive")
      .select("id")
      .eq("id", archiveRowId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const { error: updErr } = await admin
      .from("catalog_dlq_archive")
      .update({ manually_requeued_at: new Date().toISOString() })
      .eq("id", archiveRowId);
    expect(updErr).toBeNull();
  });
});
