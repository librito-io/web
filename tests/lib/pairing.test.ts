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

// Helper: stash a successful pairing_codes lookup against a future expiry so
// the per-test setup focuses on the RPC return shape (the part each scenario
// actually exercises). Returns the pairing_id used so tests can assert
// rpc args / Redis keys.
function setupValidLookup(
  supabase: ReturnType<typeof createMockSupabase>,
): string {
  const pairingId = "pairing-uuid";
  supabase._results.set("pairing_codes.select", {
    data: {
      id: pairingId,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
    error: null,
  });
  return pairingId;
}

describe("claimPairingCode", () => {
  it("delegates atomic claim to claim_pairing_atomic RPC; winner writes Redis", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = setupValidLookup(supabase);
    const rpcSpy = vi.spyOn(supabase, "rpc");
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [{ device_id: "device-uuid", device_name: "Librito", won: true }],
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
    expect(rpcSpy).toHaveBeenCalledWith("claim_pairing_atomic", {
      p_user_id: "user-uuid",
      p_pairing_id: pairingId,
      p_token_hash:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    });
    expect(redis.set).toHaveBeenCalledWith(
      `pair:token:${pairingId}`,
      "sk_device_test_token_abc123",
      { ex: 300 },
    );
  });

  it("idempotent replay (won=false) returns the existing device WITHOUT writing Redis", async () => {
    // Same-user retry path. Browser's first claim succeeded but the response
    // dropped (Safari keep-alive); the second request must NOT clobber the
    // winner's Redis token (mismatch with devices.api_token_hash would 401
    // the device on next /api/sync).
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [{ device_id: "device-uuid", device_name: "Librito", won: false }],
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
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("returns already_claimed when RPC returns no rows (different user holds claim)", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [],
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({ error: "already_claimed" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("returns already_claimed when RPC returns null (defensive)", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: null,
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({ error: "already_claimed" });
  });

  it("returns code_expired for expired codes (short-circuits RPC)", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "old-uuid",
        expires_at: new Date(Date.now() - 5000).toISOString(),
      },
      error: null,
    });
    const rpcSpy = vi.spyOn(supabase, "rpc");

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "111111",
    );

    expect(result).toEqual({ error: "code_expired" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("returns invalid_code when code does not exist", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: null,
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "999999",
    );

    expect(result).toEqual({ error: "invalid_code" });
  });

  it("returns server_error when pairing_codes lookup itself errors", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: { code: "08006", message: "connection failure" },
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({ error: "server_error" });
  });

  it("returns server_error when claim_pairing_atomic RPC errors", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: null,
      error: { message: "connection failure" },
    });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({ error: "server_error" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("rolls back via rollback_claim_pairing RPC when Redis write throws", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [{ device_id: "device-uuid", device_name: "Librito", won: true }],
      error: null,
    });
    redis.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const rpcSpy = vi.spyOn(supabase, "rpc");
    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toEqual({ error: "server_error" });
    // Two RPC calls: claim_pairing_atomic then rollback_claim_pairing.
    expect(rpcSpy).toHaveBeenCalledTimes(2);
    expect(rpcSpy).toHaveBeenNthCalledWith(2, "rollback_claim_pairing", {
      p_pairing_id: pairingId,
      p_user_id: "user-uuid",
    });
  });

  it("does NOT invoke rollback when Redis write succeeds", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [{ device_id: "device-uuid", device_name: "Librito", won: true }],
      error: null,
    });
    const rpcSpy = vi.spyOn(supabase, "rpc");

    await claimPairingCode(supabase, redis, "user-uuid", "482901");

    // Exactly one RPC call: claim_pairing_atomic. No rollback.
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      "claim_pairing_atomic",
      expect.any(Object),
    );
  });
});
