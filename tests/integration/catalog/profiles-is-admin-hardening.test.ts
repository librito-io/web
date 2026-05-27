import { describe, it, expect, afterAll } from "vitest";
import type { TransactionSql } from "postgres";
import {
  getAdmin,
  getSql,
  shutdown,
  createTestUser,
  deleteTestUser,
} from "../helpers";

/**
 * Per-transaction impersonation helper. Same shape as the RLS suite
 * (catalog-admin-actions-rls.test.ts).
 */
async function asAuthUser<T>(
  userId: string,
  work: (txn: TransactionSql) => Promise<T> | T,
): Promise<T> {
  return getSql().begin(async (txn) => {
    await txn`SELECT set_config('request.jwt.claims', ${JSON.stringify({
      sub: userId,
      role: "authenticated",
    })}, true)`;
    await txn`SET LOCAL ROLE authenticated`;
    return work(txn);
  }) as Promise<T>;
}

/**
 * Three-layered defence against profiles.is_admin self-promotion:
 *
 *   (1) Column-level GRANT — authenticated has UPDATE on display_name
 *       only; is_admin / id / created_at are NOT in the writable set.
 *   (2) Trigger profiles_prevent_is_admin_self_update — raises
 *       insufficient_privilege if OLD.is_admin IS DISTINCT FROM
 *       NEW.is_admin and current_user <> service_role.
 *   (3) Legitimate service_role UPDATE still works for the operator
 *       admin-promotion flow.
 *
 * All three are required. If a future migration accidentally widens
 * the column GRANT, the trigger backstops at the data layer; if a
 * future migration accidentally drops the trigger, the column GRANT
 * is still the boundary. These assertions pin both layers.
 */
describe.skipIf(!process.env.INTEGRATION)("profiles.is_admin hardening", () => {
  let userId: string;

  afterAll(async () => {
    if (userId) await deleteTestUser(userId).catch(() => undefined);
    await shutdown();
  });

  it("authenticated does NOT have column UPDATE on is_admin", async () => {
    const sql = getSql();
    const [{ has_privilege }] = await sql<{ has_privilege: boolean }[]>`
        SELECT has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'UPDATE') AS has_privilege
      `;
    expect(has_privilege).toBe(false);
  });

  it("authenticated has column UPDATE only on display_name", async () => {
    const sql = getSql();
    const rows = await sql<{ column_name: string }[]>`
        SELECT column_name
          FROM information_schema.column_privileges
         WHERE table_schema = 'public'
           AND table_name = 'profiles'
           AND privilege_type = 'UPDATE'
           AND grantee = 'authenticated'
         ORDER BY column_name
      `;
    expect(rows.map((r) => r.column_name)).toEqual(["display_name"]);
  });

  it("anon has no UPDATE on profiles at all", async () => {
    const sql = getSql();
    const rows = await sql<{ column_name: string }[]>`
        SELECT column_name
          FROM information_schema.column_privileges
         WHERE table_schema = 'public'
           AND table_name = 'profiles'
           AND privilege_type = 'UPDATE'
           AND grantee = 'anon'
      `;
    expect(rows).toHaveLength(0);
  });

  it("authenticated cannot self-promote via direct UPDATE (column GRANT denies)", async () => {
    const user = await createTestUser("priv-esc-column");
    userId = user.id;
    await expect(
      asAuthUser(userId, async (txn) => {
        await txn`UPDATE public.profiles SET is_admin = TRUE WHERE id = ${userId}`;
      }),
    ).rejects.toThrow(/permission denied/i);
    // Confirm row state unchanged.
    const { data: prof } = await getAdmin()
      .from("profiles")
      .select("is_admin")
      .eq("id", userId)
      .single();
    expect(prof?.is_admin).toBe(false);
  });

  it("trigger backstops a forced GRANT — service_role still works", async () => {
    const user = await createTestUser("priv-esc-trigger");
    const probeId = user.id;
    try {
      const sql = getSql();
      // Temporarily widen the GRANT (simulates a future migration
      // accidentally relaxing layer 1) then attempt UPDATE as
      // authenticated — trigger must still raise.
      await sql`GRANT UPDATE (is_admin) ON public.profiles TO authenticated`;
      try {
        await expect(
          asAuthUser(probeId, async (txn) => {
            await txn`UPDATE public.profiles SET is_admin = TRUE WHERE id = ${probeId}`;
          }),
        ).rejects.toThrow(/is_admin can only be set by service_role/i);
      } finally {
        await sql`REVOKE UPDATE (is_admin) ON public.profiles FROM authenticated`;
      }

      // service_role legitimate path still works (no trigger raise).
      const { error } = await getAdmin()
        .from("profiles")
        .update({ is_admin: true })
        .eq("id", probeId);
      expect(error).toBeNull();
      const { data: prof } = await getAdmin()
        .from("profiles")
        .select("is_admin")
        .eq("id", probeId)
        .single();
      expect(prof?.is_admin).toBe(true);
    } finally {
      await deleteTestUser(probeId);
    }
  });
});
