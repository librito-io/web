import { describe, it, expect, vi } from "vitest";

vi.mock("$lib/server/tokens", () => ({
  generatePairingCode: vi.fn(() => "482901"),
  generateDeviceToken: vi.fn(() => "sk_device_test_token_abc123"),
  hashToken: vi.fn(
    () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  ),
}));

import {
  requestPairingCode,
  checkPairingStatus,
  claimPairingCode,
} from "$lib/server/pairing";
import { createMockSupabase, createMockRedis } from "../helpers";

describe("requestPairingCode", () => {
  it("inserts a pairing code and returns code + pairingId + expiresIn", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("pairing_codes.insert", {
      data: { id: "pairing-uuid-123" },
      error: null,
    });

    const result = await requestPairingCode(supabase, "hw-device-1");

    expect(result).toEqual({
      code: "482901",
      pairingId: "pairing-uuid-123",
      expiresIn: 300,
    });
  });

  it("throws on database error", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("pairing_codes.insert", {
      data: null,
      error: { code: "42P01", message: "table not found" },
    });

    await expect(requestPairingCode(supabase, "hw-1")).rejects.toThrow();
  });
});

describe("checkPairingStatus", () => {
  it("returns paired: false when code is unclaimed", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      error: null,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({ paired: false });
  });

  it("returns paired: true with token and userEmail when code is claimed", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
      },
      error: null,
    });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 300,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      userEmail: "",
    });
  });

  it("returns code_expired when the pairing token has disappeared from redis", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
      },
      error: null,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({ error: "code_expired" });
  });

  it("returns not_found when pairingId does not exist", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: { code: "PGRST116" },
    });

    const result = await checkPairingStatus(supabase, redis, "nonexistent");
    expect(result).toEqual({ error: "not_found" });
  });

  it("returns expired when code has passed its expiry", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: false,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
      error: null,
    });

    const result = await checkPairingStatus(supabase, redis, "expired-uuid");
    expect(result).toEqual({ error: "code_expired" });
  });
});

describe("claimPairingCode", () => {
  it("validates code, creates device, stores token in redis", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();

    // Code lookup
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid",
        hardware_id: "hw-device-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
      },
      error: null,
    });
    // Conditional UPDATE returns the claimed row (we won the race)
    supabase._results.set("pairing_codes.update", {
      data: { id: "pairing-uuid" },
      error: null,
    });
    // Device insert path (no existing device)
    supabase._results.set("devices.select", { data: null, error: null });
    supabase._results.set("devices.insert", {
      data: { id: "device-uuid", name: "Librito" },
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
    expect(redis.set).toHaveBeenCalledWith(
      "pair:token:pairing-uuid",
      "sk_device_test_token_abc123",
      { ex: 300 },
    );
  });

  it("re-pairs existing device by updating token hash and clearing revoked_at", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();

    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid-2",
        hardware_id: "hw-device-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", {
      data: { id: "pairing-uuid-2" },
      error: null,
    });
    supabase._results.set("devices.select", {
      data: { id: "existing-device-uuid", name: "My Reader" },
      error: null,
    });
    supabase._results.set("devices.update", { data: null, error: null });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({
      deviceId: "existing-device-uuid",
      deviceName: "My Reader",
    });
    expect(redis.set).toHaveBeenCalledWith(
      "pair:token:pairing-uuid-2",
      "sk_device_test_token_abc123",
      { ex: 300 },
    );
  });

  it("returns code_expired for expired codes", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "old-uuid",
        hardware_id: "hw-1",
        claimed: false,
        expires_at: new Date(Date.now() - 5000).toISOString(),
        user_id: null,
      },
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "111111",
    );
    expect(result).toEqual({ error: "code_expired" });
  });

  it("replays idempotently when the same user re-claims a code they already own", async () => {
    // Safari/WebKit can silently drop a successful claim response; the browser
    // retries and must not get stuck on "already_claimed".
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "claimed-uuid",
        hardware_id: "hw-1",
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: "user-uuid",
      },
      error: null,
    });
    supabase._results.set("devices.select", {
      data: { id: "device-uuid", name: "Librito" },
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "222222",
    );
    expect(result).toEqual({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
    // Must not touch the token: prior claim remains authoritative.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("rejects cross-user replay of a claimed code", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "claimed-uuid",
        hardware_id: "hw-1",
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: "owner-user",
      },
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "attacker-user",
      "222222",
    );
    expect(result).toEqual({ error: "already_claimed" });
  });

  it("returns already_claimed when the matching device row cannot be located on replay", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "claimed-uuid",
        hardware_id: "hw-1",
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: "user-uuid",
      },
      error: null,
    });
    supabase._results.set("devices.select", { data: null, error: null });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "222222",
    );
    expect(result).toEqual({ error: "already_claimed" });
  });

  it("returns invalid_code when code does not exist", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: { code: "PGRST116" },
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "999999",
    );
    expect(result).toEqual({ error: "invalid_code" });
  });

  it("rolls back the claim when Redis token write throws; code ends unclaimed", async () => {
    // B2: a transient Upstash failure must not strand a consumed code. The
    // claim is rolled back so the user can retry without manual recovery.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    redis.set.mockRejectedValueOnce(new Error("upstash 5xx"));

    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid",
        hardware_id: "hw-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", {
      data: { id: "pairing-uuid" },
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({ error: "server_error" });
    // Two pairing_codes.update calls: claim transition + rollback.
    const codeUpdates = supabase._updateCalls.filter(
      (c) => c.table === "pairing_codes",
    );
    expect(codeUpdates).toHaveLength(2);
    expect(codeUpdates[0].payload).toMatchObject({
      claimed: true,
      user_id: "user-uuid",
    });
    expect(codeUpdates[1].payload).toMatchObject({
      claimed: false,
      user_id: null,
    });
    // No surviving Redis token.
    expect(redis._store.has("pair:token:pairing-uuid")).toBe(false);
  });

  it("folds into idempotent replay when concurrent claim by same user wins the race", async () => {
    // B3: conditional UPDATE returns null because another request already
    // flipped claimed=true. Same user → replay path returns existing device.
    const supabase = createMockSupabase();
    const redis = createMockRedis();

    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid",
        hardware_id: "hw-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
        // Re-read of winner.user_id reuses this same key; it's the same row
        // post-conditional-UPDATE so the winner's userId is the caller.
      },
      error: null,
    });
    // Conditional UPDATE returns null = race lost.
    supabase._results.set("pairing_codes.update", {
      data: null,
      error: null,
    });
    // Replay path looks up device.
    supabase._results.set("devices.select", {
      data: { id: "device-uuid", name: "Librito" },
      error: null,
    });

    // Override winner-check select to return userId === caller.
    // The mock's select chain reuses `pairing_codes.select` for both reads;
    // the second read needs winner.user_id === userId, so update the result
    // map between calls. Simpler path: stub the lookup row already has user_id
    // updated to the caller (post-conditional-UPDATE state).
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid",
        hardware_id: "hw-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: "user-uuid",
      },
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
  });

  it("returns already_claimed when concurrent claim by different user wins", async () => {
    // B3: cross-user race — winner is someone else.
    const supabase = createMockSupabase();
    const redis = createMockRedis();

    // Initial code lookup: still claimed=false (we caught it pre-race).
    // Winner re-read: user_id is the OTHER user.
    // Mock reuses one key, so set the winner-state row up front; the initial
    // read sees claimed=false (we still pass the pre-race guard) and the
    // post-UPDATE re-read sees the winner's user_id.
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid",
        hardware_id: "hw-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: "winner-user",
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", {
      data: null,
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "loser-user",
      "482901",
    );

    expect(result).toEqual({ error: "already_claimed" });
  });

  it("rolls back claim when device-write fails after winning the race", async () => {
    // Composition: claim flipped, then device insert errors. Rollback
    // pairing_codes.claimed=false so the user can retry without manual SQL.
    const supabase = createMockSupabase();
    const redis = createMockRedis();

    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid",
        hardware_id: "hw-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", {
      data: { id: "pairing-uuid" },
      error: null,
    });
    supabase._results.set("devices.select", { data: null, error: null });
    supabase._results.set("devices.insert", {
      data: null,
      error: { code: "23505", message: "unique violation" },
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({ error: "server_error" });
    // Two pairing_codes.update calls: claim transition + rollback.
    const codeUpdates = supabase._updateCalls.filter(
      (c) => c.table === "pairing_codes",
    );
    expect(codeUpdates).toHaveLength(2);
    expect(codeUpdates[0].payload).toMatchObject({
      claimed: true,
      user_id: "user-uuid",
    });
    expect(codeUpdates[1].payload).toMatchObject({
      claimed: false,
      user_id: null,
    });
    // Best-effort Redis cleanup: orphan token deleted.
    expect(redis.del).toHaveBeenCalledWith("pair:token:pairing-uuid");
    expect(redis._store.has("pair:token:pairing-uuid")).toBe(false);
  });

  it("flips the claim flag before writing Redis (winner-token invariant)", async () => {
    // Regression guard: if a future contributor moves the Redis write back
    // ahead of the conditional UPDATE, concurrent same-user double-clicks
    // clobber the winner's token and the device fetches a token whose hash
    // no longer matches devices.api_token_hash. The full post-condition is
    // covered by "concurrent claims do not clobber the winner's Redis
    // token" below; this test pins the in-process call ordering directly.
    const supabase = createMockSupabase();
    const redis = createMockRedis();

    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid",
        hardware_id: "hw-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_id: null,
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", {
      data: { id: "pairing-uuid" },
      error: null,
    });
    supabase._results.set("devices.select", { data: null, error: null });
    supabase._results.set("devices.insert", {
      data: { id: "device-uuid", name: "Librito" },
      error: null,
    });

    let redisSetOrder = -1;
    let claimUpdateOrder = -1;
    let counter = 0;
    redis.set.mockImplementationOnce(async () => {
      redisSetOrder = ++counter;
      return "OK";
    });
    const originalFrom = supabase.from;
    (supabase as unknown as { from: typeof originalFrom }).from = ((
      table: string,
    ) => {
      const builder = originalFrom.call(supabase, table);
      if (table === "pairing_codes") {
        const b = builder as unknown as {
          update: (payload: unknown) => unknown;
        };
        const origUpdate = b.update.bind(builder);
        b.update = (payload: unknown) => {
          if (claimUpdateOrder === -1) claimUpdateOrder = ++counter;
          return origUpdate(payload);
        };
      }
      return builder;
    }) as typeof originalFrom;

    await claimPairingCode(supabase, redis, "user-uuid", "482901");

    expect(claimUpdateOrder).toBeGreaterThan(0);
    expect(redisSetOrder).toBeGreaterThan(0);
    expect(claimUpdateOrder).toBeLessThan(redisSetOrder);
  });

  it("concurrent claims do not clobber the winner's Redis token", async () => {
    // Two simultaneous claimPairingCode calls for the same code, same user.
    // Mock the conditional UPDATE so call A wins (returns the row) and call
    // B loses (returns null). Post-condition: the Redis token is the
    // winner's, the persisted device hash is the winner's, the loser
    // returns the same {deviceId, deviceName} via replayClaim.
    //
    // This is the regression guard for the closed B2 race. Reordering the
    // Redis write back ahead of the conditional UPDATE breaks this test
    // because B's redis.set would clobber A's tokenA with tokenB.
    const supabaseA = createMockSupabase();
    const supabaseB = createMockSupabase();
    // Shared in-memory Redis: both racers see the same key namespace.
    const redis = createMockRedis();

    const row = {
      id: "pairing-uuid",
      hardware_id: "hw-1",
      claimed: false,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      user_id: null,
    };
    supabaseA._results.set("pairing_codes.select", {
      data: row,
      error: null,
    });
    supabaseB._results.set("pairing_codes.select", {
      data: { ...row, user_id: "user-uuid" }, // post-A-claim view for B's winner-check
      error: null,
    });

    // A wins the conditional UPDATE.
    supabaseA._results.set("pairing_codes.update", {
      data: { id: "pairing-uuid" },
      error: null,
    });
    // B loses (returns null).
    supabaseB._results.set("pairing_codes.update", {
      data: null,
      error: null,
    });

    supabaseA._results.set("devices.select", { data: null, error: null });
    supabaseA._results.set("devices.insert", {
      data: { id: "device-uuid", name: "Librito" },
      error: null,
    });
    // B's replayClaim sees A's provisioned device.
    supabaseB._results.set("devices.select", {
      data: { id: "device-uuid", name: "Librito" },
      error: null,
    });

    // A and B share the SAME generated token because tokens.ts is mocked at
    // the top of this file to return a constant. That's accidentally
    // perfect for asserting "winner's token survives" — if B's set EVER ran
    // after A's it would write the same value. To make the regression
    // visible, override generateDeviceToken so A and B return distinct
    // tokens.
    const tokensModule = await import("$lib/server/tokens");
    const generateMock = tokensModule.generateDeviceToken as unknown as {
      mockReturnValueOnce: (v: string) => unknown;
    };
    generateMock.mockReturnValueOnce("sk_device_tokenA");
    generateMock.mockReturnValueOnce("sk_device_tokenB");

    const [resultA, resultB] = await Promise.all([
      claimPairingCode(supabaseA, redis, "user-uuid", "482901"),
      claimPairingCode(supabaseB, redis, "user-uuid", "482901"),
    ]);

    expect(resultA).toEqual({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
    expect(resultB).toEqual({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
    // The Redis token is A's (the conditional-UPDATE winner). B never
    // reaches the Redis write because its conditional UPDATE returned null.
    const tokenInRedis = await redis.get("pair:token:pairing-uuid");
    expect(tokenInRedis).toBe("sk_device_tokenA");
    // B's redis.set was never invoked.
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
});
