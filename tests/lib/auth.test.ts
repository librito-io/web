import { describe, it, expect } from "vitest";
import { authenticateDevice } from "$lib/server/auth";
import { hashToken } from "$lib/server/tokens";
import { createMockSupabase } from "../helpers";

const TEST_TOKEN = "sk_device_test_token_abc123def456";
const TEST_HASH = hashToken(TEST_TOKEN);

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return new Request("https://librito.io/api/sync", { headers });
}

describe("authenticateDevice", () => {
  it("returns device for a valid token", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("devices.select", {
      data: {
        id: "device-uuid",
        user_id: "user-uuid",
        hardware_id: "hw-001",
        name: "My Reader",
        revoked_at: null,
      },
      error: null,
    });

    const result = await authenticateDevice(makeRequest(TEST_TOKEN), supabase);
    expect(result).toEqual({
      device: {
        id: "device-uuid",
        userId: "user-uuid",
        hardwareId: "hw-001",
        name: "My Reader",
      },
    });
  });

  it("returns missing_token when Authorization header is absent", async () => {
    const supabase = createMockSupabase();
    const result = await authenticateDevice(
      new Request("https://librito.io/api/sync"),
      supabase,
    );
    expect(result).toEqual({ error: "missing_token" });
  });

  it("returns missing_token when Authorization header is not Bearer", async () => {
    const supabase = createMockSupabase();
    const req = new Request("https://librito.io/api/sync", {
      headers: { Authorization: "Basic abc123" },
    });
    const result = await authenticateDevice(req, supabase);
    expect(result).toEqual({ error: "missing_token" });
  });

  it("returns invalid_token when token does not start with sk_device_", async () => {
    const supabase = createMockSupabase();
    const result = await authenticateDevice(
      makeRequest("not_a_device_token"),
      supabase,
    );
    expect(result).toEqual({ error: "invalid_token" });
  });

  it("returns invalid_token when no device matches the hash", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("devices.select", {
      data: null,
      error: { code: "PGRST116" },
    });

    const result = await authenticateDevice(
      makeRequest("sk_device_unknown_token"),
      supabase,
    );
    expect(result).toEqual({ error: "invalid_token" });
  });

  it("returns token_revoked when device is revoked", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("devices.select", {
      data: {
        id: "device-uuid",
        user_id: "user-uuid",
        hardware_id: "hw-001",
        name: "Revoked Reader",
        revoked_at: "2026-04-10T00:00:00Z",
      },
      error: null,
    });

    const result = await authenticateDevice(makeRequest(TEST_TOKEN), supabase);
    expect(result).toEqual({ error: "token_revoked" });
  });
});
