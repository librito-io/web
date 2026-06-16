// tests/routes/import-kobo-contract.test.ts
//
// web #538 — freeze the SERIALIZED HTTP auth-failure body of POST
// /api/import/kobo. The Kobo device hard-depends on the literal `token_revoked`
// wire string to trigger its credential-rejected local wipe; auth.test.ts pins
// only the return-OBJECT shape, so a refactor that renamed the code, wrapped
// the body, or changed the status would break the device with web unit tests
// still green. This test exercises the FULL chain
//   route → authenticateDevice → authErrorResponse → jsonError → HTTP body
// by deliberately NOT mocking $lib/server/auth.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockSupabase } from "../helpers";

// The route statically imports ratelimit.ts → $env/static/private. Auth fails
// before the rate-limit step, so these values are never read; the mock just
// lets the module import.
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } = await import("../../src/routes/api/import/kobo/+server");

const VALID_DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const VALID_USER_ID = "22222222-2222-4222-8222-222222222222";

function buildEvent() {
  return {
    request: new Request("http://x/api/import/kobo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer sk_device_contract_test_token",
      },
      body: JSON.stringify({ items: [], complete: false }),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/import/kobo — auth-failure wire contract (web #538)", () => {
  beforeEach(() => {
    supabase._results.clear();
  });

  it("revoked device → 401 { error: 'token_revoked' } (the literal string the device's wipe gate keys on)", async () => {
    supabase._results.set("devices.select", {
      data: {
        id: VALID_DEVICE_ID,
        user_id: VALID_USER_ID,
        hardware_id: "hw-001",
        name: "Revoked Kobo",
        revoked_at: "2026-06-10T00:00:00Z",
      },
      error: null,
    });

    const res = await POST(buildEvent());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("token_revoked");
  });

  it("PGRST116 row-miss → 401 { error: 'invalid_token' } (deleted/rotated row also wipes)", async () => {
    supabase._results.set("devices.select", {
      data: null,
      error: { code: "PGRST116" },
    });

    const res = await POST(buildEvent());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_token");
  });

  it("transient DB error → 503 { error: 'server_error' }, NEVER invalid_token (the self-wipe-on-blip regression #538 guards)", async () => {
    supabase._results.set("devices.select", {
      data: null,
      error: {
        code: "57014",
        message: "canceling statement due to statement timeout",
      },
    });

    const res = await POST(buildEvent());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("server_error");
    expect(body.error).not.toBe("invalid_token");
  });
});
