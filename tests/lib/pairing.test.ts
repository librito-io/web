import { describe, it, expect, vi, beforeEach } from "vitest";

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

  it("returns paired: true with token and transferSecret when code is claimed", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        transfer_secret: null,
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", { data: null, error: null });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 600,
    });
    await redis.set("pair:secret:pairing-uuid", "base64secret==", { ex: 600 });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      transferSecret: "base64secret==",
    });
  });

  it("returns transferSecret from DB when Redis secret is missing", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        transfer_secret: "db_fallback_secret==",
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", { data: null, error: null });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 600,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      transferSecret: "db_fallback_secret==",
    });
    // Should clear the DB secret
    expect(supabase._results.get("pairing_codes.update")).toBeDefined();
  });

  it("returns null transferSecret when neither Redis nor DB has the secret", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        transfer_secret: null,
      },
      error: null,
    });
    supabase._results.set("pairing_codes.update", { data: null, error: null });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 600,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      transferSecret: null,
    });
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
      },
      error: null,
    });
    // Code update (mark claimed)
    supabase._results.set("pairing_codes.update", { data: null, error: null });
    // Device insert
    supabase._results.set("devices.select", {
      data: null,
      error: { code: "PGRST116" },
    });
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

    expect(result).toMatchObject({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
    expect("transferSecret" in result && !("error" in result)).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      "pair:token:pairing-uuid",
      "sk_device_test_token_abc123",
      { ex: 600 },
    );
    // Also stores transfer secret in Redis
    expect(redis.set).toHaveBeenCalledWith(
      "pair:secret:pairing-uuid",
      expect.any(String),
      { ex: 600 },
    );
  });

  it("re-pairs existing device by updating token hash and clearing revoked_at", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();

    // Code lookup
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "pairing-uuid-2",
        hardware_id: "hw-device-1",
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      error: null,
    });
    // Code update (mark claimed)
    supabase._results.set("pairing_codes.update", { data: null, error: null });
    // Existing device found (re-pair case)
    supabase._results.set("devices.select", {
      data: { id: "existing-device-uuid", name: "My Reader" },
      error: null,
    });
    // Device update (token rotation)
    supabase._results.set("devices.update", { data: null, error: null });

    const result = await claimPairingCode(
      supabase,
      redis,
      "user-uuid",
      "482901",
    );

    expect(result).toMatchObject({
      deviceId: "existing-device-uuid",
      deviceName: "My Reader",
    });
    expect("transferSecret" in result && !("error" in result)).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      "pair:token:pairing-uuid-2",
      "sk_device_test_token_abc123",
      { ex: 600 },
    );
    expect(redis.set).toHaveBeenCalledWith(
      "pair:secret:pairing-uuid-2",
      expect.any(String),
      { ex: 600 },
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

  it("returns already_claimed for claimed codes", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "claimed-uuid",
        hardware_id: "hw-1",
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      error: null,
    });

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
});
