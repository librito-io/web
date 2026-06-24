import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// device type/model flow through claim_pairing_atomic (issue #505).
//
// device_type / device_model are device-supplied at request time, written
// onto the pairing_codes row, and read by claim_pairing_atomic into the
// devices row via its RETURNING ... INTO — the same path hardware_id takes.
// The RPC signature is unchanged (5-arg); these tests lock in that the
// row-borne values land on devices.type / devices.model on the fresh-INSERT
// claim path and refresh on the ON CONFLICT re-pair path, while the
// user-chosen name survives re-pair.

const SKIP = !process.env.INTEGRATION;

const POLL_HASH = "0".repeat(64); // poll_secret_hash is NOT NULL; placeholder.

describe.skipIf(SKIP)("device type/model via claim_pairing_atomic", () => {
  const sql = getSql();
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser("device-type-model-claim");
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
    await shutdown();
  });

  // Mint a fresh pairing_codes row carrying the given type/model.
  async function mintCode(opts: {
    hardwareId: string;
    code: string;
    deviceType?: string;
    deviceModel?: string | null;
  }): Promise<string> {
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    // Let the column defaults apply when type is omitted (PaperS3 path).
    if (opts.deviceType === undefined) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO public.pairing_codes (code, hardware_id, expires_at, poll_secret_hash)
        VALUES (${opts.code}, ${opts.hardwareId}, ${expires}, ${POLL_HASH})
        RETURNING id
      `;
      return row.id;
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO public.pairing_codes
        (code, hardware_id, expires_at, poll_secret_hash, device_type, device_model)
      VALUES (${opts.code}, ${opts.hardwareId}, ${expires}, ${POLL_HASH},
              ${opts.deviceType}, ${opts.deviceModel ?? null})
      RETURNING id
    `;
    return row.id;
  }

  async function claim(pairingId: string, tokenHash: string) {
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
        ${pairingId}::uuid,
        ${tokenHash}::text,
        ${user.email}::text,
        ${10}::integer
      )
    `;
    return result;
  }

  async function readDevice(
    id: string,
  ): Promise<{ type: string; model: string | null; name: string }> {
    const [row] = await sql<
      { type: string; model: string | null; name: string }[]
    >`SELECT type, model, name FROM public.devices WHERE id = ${id}`;
    return row;
  }

  it("writes type='kobo' and the model onto a freshly inserted device", async () => {
    const hardwareId = `hw-${Math.random().toString(36).slice(2, 10)}`;
    const pairingId = await mintCode({
      hardwareId,
      code: "K00001",
      deviceType: "kobo",
      deviceModel: "Kobo Libra Colour",
    });

    const result = await claim(pairingId, "tok-kobo-1");
    expect(result.won).toBe(true);

    const device = await readDevice(result.device_id);
    expect(device.type).toBe("kobo");
    expect(device.model).toBe("Kobo Libra Colour");
    expect(device.name).toBe("Kobo Libra Colour"); // name seeded from model
    expect(result.device_name).toBe("Kobo Libra Colour"); // RETURNING echoes it
  });

  it("defaults type='papers3', model=NULL when the row omits them", async () => {
    const hardwareId = `hw-${Math.random().toString(36).slice(2, 10)}`;
    const pairingId = await mintCode({ hardwareId, code: "P00001" });

    const result = await claim(pairingId, "tok-papers3-1");
    expect(result.won).toBe(true);

    const device = await readDevice(result.device_id);
    expect(device.type).toBe("papers3");
    expect(device.model).toBeNull();
    expect(device.name).toBe("PaperS3"); // NULL model → type-label fallback
  });

  it("falls back to the type label when a kobo reports no model", async () => {
    const hardwareId = `hw-${Math.random().toString(36).slice(2, 10)}`;
    const pairingId = await mintCode({
      hardwareId,
      code: "K00002",
      deviceType: "kobo",
      deviceModel: null,
    });

    const result = await claim(pairingId, "tok-kobo-nomodel");
    expect(result.won).toBe(true);

    const device = await readDevice(result.device_id);
    expect(device.name).toBe("Kobo");
  });

  it("refreshes type/model on re-pair but preserves the user-chosen name", async () => {
    const hardwareId = `hw-${Math.random().toString(36).slice(2, 10)}`;

    // First pair as kobo, then the user renames the device.
    const firstId = await mintCode({
      hardwareId,
      code: "R00001",
      deviceType: "kobo",
      deviceModel: "Kobo Clara BW",
    });
    const first = await claim(firstId, "tok-repair-1");
    const deviceId = first.device_id;
    await sql`UPDATE public.devices SET name = ${"Sarah's Kobo"} WHERE id = ${deviceId}`;

    // Re-pair the same hardware reporting a corrected model (ON CONFLICT path).
    const secondId = await mintCode({
      hardwareId,
      code: "R00002",
      deviceType: "kobo",
      deviceModel: "Kobo Libra Colour",
    });
    const second = await claim(secondId, "tok-repair-2");
    expect(second.won).toBe(true);
    expect(second.device_id).toBe(deviceId); // same row

    const device = await readDevice(deviceId);
    expect(device.model).toBe("Kobo Libra Colour"); // refreshed
    expect(device.type).toBe("kobo");
    expect(device.name).toBe("Sarah's Kobo"); // user name survives re-pair
  });

  it("rejects an out-of-set type at the DB CHECK (defense-in-depth backstop)", async () => {
    // The TS layer coerces unknown types, so a bad value should never reach
    // the row in production. This asserts the CHECK is the hard backstop if
    // it ever does (e.g. direct SQL, a future caller bypassing the helper).
    const hardwareId = `hw-${Math.random().toString(36).slice(2, 10)}`;
    const pairingId = await mintCode({
      hardwareId,
      code: "B00001",
      deviceType: "bogus",
    });

    await expect(claim(pairingId, "tok-bogus-1")).rejects.toMatchObject({
      code: "23514", // check_violation: valid_device_type
    });
  });
});
