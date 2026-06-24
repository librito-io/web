import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthUser,
  createTestUser,
  deleteTestUser,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// devices_prevent_unrevoke trigger — token-co-rotation invariant.
//
// Verifies the refinement landed in 20260516000003 (issue #183):
//
//   "A revoked token cannot be un-revoked. Clearing revoked_at requires
//    rotating api_token_hash in the same UPDATE."
//
// The original form from 20260516000002 (PR #181) enforced row-level
// immutability of revoked_at, which blocked the legitimate re-pair flow
// in claim_pairing_atomic. This suite locks in the corrected semantics
// against future regressions in either direction:
//
//   - Loosening (dropping the trigger, or weakening to only-service-role)
//     would re-open issue #180.
//   - Tightening back to row-level immutability would re-introduce the
//     #183 regression — re-pair of any previously-unpaired device fails.
//
// The five cases mirror the verification matrix in the issue body.

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)(
  "devices_prevent_unrevoke: token-co-rotation invariant",
  () => {
    const sql = getSql();
    let user: TestUser;
    let deviceId: string;
    const hardwareId = `hw-${Math.random().toString(36).slice(2, 10)}`;

    beforeAll(async () => {
      user = await createTestUser("devices-unrevoke-trigger");

      const [device] = await sql<{ id: string }[]>`
      INSERT INTO public.devices (user_id, hardware_id, api_token_hash, name, revoked_at)
      VALUES (${user.id}, ${hardwareId}, ${"hash-initial"}, ${"Test Device"}, ${new Date().toISOString()})
      RETURNING id
    `;
      deviceId = device.id;
    });

    afterAll(async () => {
      await deleteTestUser(user.id);
      await shutdown();
    });

    // Helper: reset device to revoked-with-known-hash between cases so each
    // test sees a deterministic OLD state. Bypasses the trigger by writing
    // revoked_at directly (NULL → NOT NULL is always allowed).
    async function resetToRevoked(hash: string) {
      await sql`
      UPDATE public.devices
         SET api_token_hash = ${hash},
             revoked_at = now()
       WHERE id = ${deviceId}
    `;
    }

    it("rejects service-role un-revoke without rotating api_token_hash", async () => {
      await resetToRevoked("hash-case-1");

      await expect(
        sql`UPDATE public.devices SET revoked_at = NULL WHERE id = ${deviceId}`,
      ).rejects.toMatchObject({
        // SQLSTATE 23514 = check_violation, matches the RAISE EXCEPTION's USING ERRCODE.
        code: "23514",
      });
    });

    it("rejects authenticated un-revoke without rotating api_token_hash", async () => {
      await resetToRevoked("hash-case-2");

      // Run under the authenticated role so RLS + GRANTs apply the same way
      // PostgREST would route a PATCH. The trigger fires regardless of role.
      await expect(
        asAuthUser(user.id, async (txn) => {
          await txn`UPDATE public.devices SET revoked_at = NULL WHERE id = ${deviceId} AND user_id = ${user.id}`;
        }),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("denies authenticated UPDATE on api_token_hash via column grant (defense in depth)", async () => {
      await resetToRevoked("hash-case-3");

      // The column GRANT in 20260516000002 omits api_token_hash for the
      // `authenticated` role, so PostgREST denies before the trigger ever
      // fires. SQLSTATE 42501 = insufficient_privilege. This is the second
      // layer of defense after the trigger.
      await expect(
        asAuthUser(user.id, async (txn) => {
          await txn`UPDATE public.devices SET revoked_at = NULL, api_token_hash = ${"attacker-chosen"} WHERE id = ${deviceId}`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("permits service-role un-revoke when api_token_hash is rotated in the same UPDATE", async () => {
      await resetToRevoked("hash-case-4-old");

      await sql`
      UPDATE public.devices
         SET revoked_at = NULL,
             api_token_hash = ${"hash-case-4-new"}
       WHERE id = ${deviceId}
    `;

      const [row] = await sql<
        { revoked_at: string | null; api_token_hash: string }[]
      >`SELECT revoked_at, api_token_hash FROM public.devices WHERE id = ${deviceId}`;
      expect(row.revoked_at).toBeNull();
      expect(row.api_token_hash).toBe("hash-case-4-new");
    });

    it("permits re-pair via claim_pairing_atomic against a revoked row", async () => {
      await resetToRevoked("hash-case-5-old");

      // poll_secret_hash NOT NULL post-migration 20260520000004; this test
      // only exercises the claim atomic RPC, so a placeholder 64-char hex
      // value satisfies the constraint without affecting behavior.
      const [pairing] = await sql<{ id: string }[]>`
      INSERT INTO public.pairing_codes (code, hardware_id, expires_at, poll_secret_hash)
      VALUES (${"TEST5"}, ${hardwareId}, ${new Date(Date.now() + 5 * 60 * 1000).toISOString()}, ${"0".repeat(64)})
      RETURNING id
    `;

      const [result] = await sql<
        {
          device_id: string;
          device_name: string;
          won: boolean;
          expired: boolean;
        }[]
      >`
      SELECT * FROM public.claim_pairing_atomic(
        ${user.id}::uuid,
        ${pairing.id}::uuid,
        ${"hash-case-5-new"}::text,
        ${user.email}::text,
        ${10}::integer
      )
    `;
      expect(result.won).toBe(true);
      expect(result.device_id).toBe(deviceId);

      const [row] = await sql<
        { revoked_at: string | null; api_token_hash: string }[]
      >`SELECT revoked_at, api_token_hash FROM public.devices WHERE id = ${deviceId}`;
      expect(row.revoked_at).toBeNull();
      expect(row.api_token_hash).toBe("hash-case-5-new");
    });
  },
);
