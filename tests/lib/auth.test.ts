import { describe, it, expect } from "vitest";
import { authenticateDevice } from "$lib/server/auth";
import { createMockSupabase } from "../helpers";

const TEST_TOKEN = "sk_device_test_token_abc123def456";
const VALID_DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const VALID_USER_ID = "22222222-2222-4222-8222-222222222222";

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
        id: VALID_DEVICE_ID,
        user_id: VALID_USER_ID,
        hardware_id: "hw-001",
        name: "My Reader",
        revoked_at: null,
      },
      error: null,
    });

    const result = await authenticateDevice(makeRequest(TEST_TOKEN), supabase);
    expect(result).toEqual({
      device: {
        id: VALID_DEVICE_ID,
        userId: VALID_USER_ID,
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

  it("returns invalid_token when device.id is not a valid UUID", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("devices.select", {
      data: {
        id: "not-a-uuid'); DROP TABLE devices;--",
        user_id: VALID_USER_ID,
        hardware_id: "hw-001",
        name: "Sketchy Reader",
        revoked_at: null,
      },
      error: null,
    });

    const result = await authenticateDevice(makeRequest(TEST_TOKEN), supabase);
    expect(result).toEqual({ error: "invalid_token" });
  });

  it("returns invalid_token when device.user_id is not a valid UUID", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("devices.select", {
      data: {
        id: VALID_DEVICE_ID,
        user_id: "not-a-uuid",
        hardware_id: "hw-001",
        name: "Sketchy Reader",
        revoked_at: null,
      },
      error: null,
    });

    const result = await authenticateDevice(makeRequest(TEST_TOKEN), supabase);
    expect(result).toEqual({ error: "invalid_token" });
  });

  it("returns token_revoked when device is revoked", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("devices.select", {
      data: {
        id: VALID_DEVICE_ID,
        user_id: VALID_USER_ID,
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
