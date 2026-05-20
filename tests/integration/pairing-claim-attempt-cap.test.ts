import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// Per-code global attempt cap on claim_pairing_atomic — issue #260.
//
// Verifies the migration 20260520000001 contract end-to-end against a real
// Postgres: the claim_attempts counter increments on every entry (regardless
// of source IP) and the RPC refuses with expired=true once the cap is
// exceeded. The unit-test surface in tests/lib/pairing.test.ts covers the
// TS-side wiring; this suite covers what mocks cannot — the atomic
// increment + cap check inside the advisory-locked transaction.
//
// Out of scope: route-level rate limiter (keyed on ${code}:${ip}); that
// suite would touch Upstash and lives separately. The whole point of #260
// is that this RPC-level cap is IP-blind.

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)("claim_pairing_atomic: per-code attempt cap", () => {
  const sql = getSql();
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser("pairing-claim-attempt-cap");
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
    await shutdown();
  });

  // Helper: mint a fresh pairing_codes row per test so each scenario starts
  // from claim_attempts=0. Hardware id is randomised so concurrent test runs
  // don't collide on devices_user_id_hardware_id_key.
  async function newPairingCode(label: string): Promise<{
    id: string;
    code: string;
    hardwareId: string;
  }> {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hardwareId = `hw-${label}-${Math.random().toString(36).slice(2, 10)}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO public.pairing_codes (code, hardware_id, expires_at)
      VALUES (${code}, ${hardwareId}, ${new Date(Date.now() + 5 * 60 * 1000).toISOString()})
      RETURNING id
    `;
    return { id: row.id, code, hardwareId };
  }

  async function callClaim(
    pairingId: string,
    tokenHash: string,
    maxAttempts: number,
  ) {
    const [row] = await sql<
      {
        device_id: string | null;
        device_name: string | null;
        won: boolean | null;
        expired: boolean | null;
      }[]
    >`
      SELECT * FROM public.claim_pairing_atomic(
        ${user.id}::uuid,
        ${pairingId}::uuid,
        ${tokenHash}::text,
        ${user.email}::text,
        ${maxAttempts}::integer
      )
    `;
    return row ?? null;
  }

  async function readAttempts(pairingId: string): Promise<number> {
    const [row] = await sql<{ claim_attempts: number }[]>`
      SELECT claim_attempts FROM public.pairing_codes WHERE id = ${pairingId}
    `;
    return row.claim_attempts;
  }

  it("admits the first cap attempts, refuses the (cap+1)th with expired=true", async () => {
    const { id } = await newPairingCode("admit-then-refuse");
    const cap = 10;

    // First call wins, sets up the device row. Subsequent calls are
    // idempotent replays since they're from the same user.
    const first = await callClaim(id, "hash-1", cap);
    expect(first?.won).toBe(true);
    expect(first?.expired).toBe(false);

    for (let i = 2; i <= cap; i++) {
      const replay = await callClaim(id, `hash-replay-${i}`, cap);
      // Replay branch: same user holds the claim, won=false, device row
      // returned, expired=false. Token rotation on replay is intentionally
      // not exercised here — claim_pairing_atomic only rotates on the
      // winner's path (claimed=false → true transition).
      expect(replay?.won).toBe(false);
      expect(replay?.expired).toBe(false);
      expect(replay?.device_id).not.toBeNull();
    }

    expect(await readAttempts(id)).toBe(cap);

    // (cap+1)th entry → refused via expired=true sentinel.
    const refused = await callClaim(id, "hash-over-cap", cap);
    expect(refused?.expired).toBe(true);
    expect(refused?.won).toBe(false);
    expect(refused?.device_id).toBeNull();
    expect(refused?.device_name).toBeNull();

    // Counter advanced by the refused attempt too — the increment is
    // unconditional, before the cap branch.
    expect(await readAttempts(id)).toBe(cap + 1);
  });

  it("increments claim_attempts atomically under concurrent fan-out (no lost updates)", async () => {
    // Eight parallel callers against a fresh code. The pg_advisory_xact_lock
    // serializes them per pairing_id, so the final counter must equal the
    // fan-out count exactly (no double-counted increments, no lost ones).
    const { id } = await newPairingCode("concurrent-fanout");
    const fanOut = 8;
    const cap = 100; // Well above fanOut; we're measuring the counter, not the cap.

    const calls = Array.from({ length: fanOut }, (_, i) =>
      callClaim(id, `hash-concurrent-${i}`, cap),
    );
    const results = await Promise.all(calls);

    // Exactly one winner among the concurrent callers (the others observe
    // the committed claim under the advisory lock and take the replay path).
    const winners = results.filter((r) => r?.won === true);
    expect(winners).toHaveLength(1);

    // No caller hit the cap (it is well above fanOut), so no expired rows.
    const expired = results.filter((r) => r?.expired === true);
    expect(expired).toHaveLength(0);

    // Counter exactly equals fan-out — proves the increment is serialised
    // and atomic with the rest of the transaction.
    expect(await readAttempts(id)).toBe(fanOut);
  });

  it("counter is per-code: a separate code starts at 0 even after another code hits the cap", async () => {
    // Implicit reset via 5-min TTL is exercised by every newPairingCode
    // call (each mints a fresh row). This test makes the per-code isolation
    // explicit: hitting the cap on one code does not poison a sibling.
    const cap = 3;
    const codeA = await newPairingCode("isolation-a");
    const codeB = await newPairingCode("isolation-b");

    // Burn codeA past the cap. First call wins, next two replays, fourth
    // refused. Both share the same user/hardwareId namespace at the
    // hardware_id level (they don't), so each is independent.
    expect((await callClaim(codeA.id, "ha-1", cap))?.won).toBe(true);
    expect((await callClaim(codeA.id, "ha-2", cap))?.won).toBe(false);
    expect((await callClaim(codeA.id, "ha-3", cap))?.won).toBe(false);
    expect((await callClaim(codeA.id, "ha-4", cap))?.expired).toBe(true);

    // codeB is untouched.
    expect(await readAttempts(codeB.id)).toBe(0);
    const bFirst = await callClaim(codeB.id, "hb-1", cap);
    expect(bFirst?.won).toBe(true);
    expect(bFirst?.expired).toBe(false);
    expect(await readAttempts(codeB.id)).toBe(1);
  });
});
