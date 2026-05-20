import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import {
  createTestUser,
  deleteTestUser,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// devices write surface — column GRANT scope + RLS USING enforcement.
//
// Companion suite to devices-unrevoke-trigger.test.ts. Together they pin
// down the three layers that PR #181 (commit 8aa6256) added on top of the
// "Users can update own devices" RLS policy from PR #179 (commit be09c3a):
//
//   Layer 1: column GRANT — authenticated may UPDATE only (name, revoked_at)
//   Layer 2: RLS USING + WITH CHECK on user_id ownership
//   Layer 3: devices_prevent_unrevoke trigger (covered separately)
//
// Issue #182 asked specifically for column-GRANT-per-column coverage and
// RLS USING coverage that unit tests cannot observe — the .eq("user_id")
// defense-in-depth predicate in src/routes/app/devices/+page.server.ts is
// invisible to the chain-proxy mock in tests/helpers.ts. The assertions
// below are exactly what regresses if a future migration:
//
//   - widens the column GRANT (e.g. adds hardware_id back)
//   - drops the RLS policy or removes its WITH CHECK
//   - swaps the /app/devices route back to the admin client
//
// SQLSTATE 42501 = insufficient_privilege; postgres raises this at the
// column-permission check before RLS or trigger evaluation. RLS USING
// failures do NOT raise — the row is silently filtered out and the
// UPDATE returns rowCount 0.

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)("devices write surface — column GRANT + RLS", () => {
  const sql = getSql();
  let userA: TestUser;
  let userB: TestUser;
  let deviceA: string;
  let deviceB: string;

  beforeAll(async () => {
    userA = await createTestUser("devices-write-surface-a");
    userB = await createTestUser("devices-write-surface-b");

    const hwA = `hw-${Math.random().toString(36).slice(2, 10)}`;
    const hwB = `hw-${Math.random().toString(36).slice(2, 10)}`;

    const [a] = await sql<{ id: string }[]>`
      INSERT INTO public.devices (user_id, hardware_id, api_token_hash, name)
      VALUES (${userA.id}, ${hwA}, ${"hash-a"}, ${"Device A"})
      RETURNING id
    `;
    deviceA = a.id;

    const [b] = await sql<{ id: string }[]>`
      INSERT INTO public.devices (user_id, hardware_id, api_token_hash, name)
      VALUES (${userB.id}, ${hwB}, ${"hash-b"}, ${"Device B"})
      RETURNING id
    `;
    deviceB = b.id;
  });

  afterAll(async () => {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
    await shutdown();
  });

  // Helper: run a block as the authenticated role with userA's JWT claims.
  // The explicit cast is because postgres-js's `sql.begin` is overloaded and
  // its inferred-return generic collapses to `never` when chained through a
  // local helper. The runtime contract is "txn is a TransactionSql"; the
  // cast pins that for the typechecker without changing behaviour.
  async function asUserA<T>(
    work: (txn: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return sql.begin(async (txn) => {
      await txn`SELECT set_config('request.jwt.claims', ${JSON.stringify({
        sub: userA.id,
        role: "authenticated",
      })}, true)`;
      await txn`SET LOCAL ROLE authenticated`;
      return work(txn);
    }) as Promise<T>;
  }

  // -----------------------------------------------------------------
  // Layer 1 — column GRANT scope
  // -----------------------------------------------------------------
  //
  // The GRANT in 20260516000002 narrows authenticated UPDATE to
  // (name, revoked_at). Every other column must reject with 42501
  // BEFORE RLS or any trigger fires. Each forbidden column gets its
  // own assertion — a future REVOKE-and-re-GRANT migration that
  // accidentally widens by one column will fail one row of this
  // table and surface the regression by column name.

  const FORBIDDEN_COLUMNS: Array<{
    column: string;
    setExpr: string;
  }> = [
    // api_token_hash is also exercised in devices-unrevoke-trigger.test.ts
    // case 3, but included here for symmetry — the documented invariant is
    // "authenticated can UPDATE only (name, revoked_at)", and that's what
    // this table asserts as a single coherent regression guard.
    { column: "api_token_hash", setExpr: `api_token_hash = 'forged'` },
    { column: "hardware_id", setExpr: `hardware_id = 'spoof'` },
    { column: "paired_at", setExpr: `paired_at = NOW()` },
    { column: "last_synced_at", setExpr: `last_synced_at = NOW()` },
    { column: "created_at", setExpr: `created_at = NOW()` },
  ];

  for (const { column, setExpr } of FORBIDDEN_COLUMNS) {
    it(`column GRANT: authenticated cannot UPDATE devices.${column}`, async () => {
      await expect(
        asUserA(async (txn) => {
          // sql.unsafe is required because the SET clause is a literal
          // SQL fragment; the value side is still hardcoded above (no
          // user input flows in). The id binding stays parameterised.
          await txn.unsafe(
            `UPDATE public.devices SET ${setExpr} WHERE id = $1`,
            [deviceA],
          );
        }),
      ).rejects.toMatchObject({ code: "42501" });
    });
  }

  it("column GRANT: authenticated cannot reassign user_id (RLS WITH CHECK is shielded by GRANT today)", async () => {
    // user_id is not in the column GRANT, so this fails at 42501 before
    // RLS WITH CHECK gets a chance. The WITH CHECK on user_id = auth.uid()
    // is still the canonical RLS-layer guard documented in
    // 20260516000001 — if a future migration adds user_id back to the
    // GRANT, the WITH CHECK becomes the active line of defense and this
    // test will need an additional sub-assertion (the WITH CHECK should
    // reject with code "42501"-ish or RLS-deny → 0 rows). Today, the
    // GRANT denial is the observable behaviour.
    await expect(
      asUserA(async (txn) => {
        await txn`UPDATE public.devices SET user_id = ${userB.id} WHERE id = ${deviceA}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("column GRANT: authenticated CAN UPDATE devices.name", async () => {
    const rows = await asUserA(async (txn) => {
      return txn<{ id: string; name: string }[]>`
        UPDATE public.devices SET name = ${"Renamed A"} WHERE id = ${deviceA}
        RETURNING id, name
      `;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Renamed A");
  });

  it("column GRANT: authenticated CAN UPDATE devices.revoked_at (NULL → NOT NULL)", async () => {
    // Confirms the column is in the GRANT. The one-way trigger forbids
    // the reverse transition (NULL → NOT NULL is fine; NOT NULL → NULL
    // is rejected — see devices-unrevoke-trigger.test.ts cases 1 & 2).
    // Use a freshly-inserted device to keep this case independent of
    // the trigger suite's state.
    const [scratch] = await sql<{ id: string }[]>`
      INSERT INTO public.devices (user_id, hardware_id, api_token_hash, name)
      VALUES (${userA.id}, ${`hw-revoke-${Math.random().toString(36).slice(2, 10)}`}, ${"hash-revoke"}, ${"Revoke Test"})
      RETURNING id
    `;

    const rows = await asUserA(async (txn) => {
      return txn<{ id: string; revoked_at: string | null }[]>`
        UPDATE public.devices SET revoked_at = NOW() WHERE id = ${scratch.id}
        RETURNING id, revoked_at
      `;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  // -----------------------------------------------------------------
  // Layer 2 — RLS USING (row ownership)
  // -----------------------------------------------------------------
  //
  // The USING clause on the "Users can update own devices" policy
  // filters rows to (auth.uid() = user_id). An UPDATE targeting
  // another user's row silently affects 0 rows — no error.

  it("RLS USING: authenticated cannot UPDATE another user's device (0 rows affected)", async () => {
    const rows = await asUserA(async (txn) => {
      return txn<{ id: string }[]>`
        UPDATE public.devices SET name = ${"Hijacked"} WHERE id = ${deviceB}
        RETURNING id
      `;
    });
    expect(rows).toHaveLength(0);

    // Sanity: confirm userB's device name is untouched.
    const [persisted] = await sql<{ name: string }[]>`
      SELECT name FROM public.devices WHERE id = ${deviceB}
    `;
    expect(persisted.name).toBe("Device B");
  });
});
