// tests/routes/import-kobo-timestamps.test.ts
//
// web #541 — POST /api/import/kobo must bump the device's last_synced_at /
// last_used_at after a successful import, mirroring the PaperS3 /api/sync path
// (src/lib/server/sync.ts). Without this the /app/devices "last synced" column
// never advances for a Kobo, even though imports succeed.
//
// We stub the import module (validateKoboPayload / processKoboImport) and the
// rate limiter so the test exercises only the handler's post-import timestamp
// bump, not the full DB import machinery (covered by the integration suite).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockSupabase } from "../helpers";

// The route statically imports ratelimit.ts → $env/static/private.
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

// Rate limit is not under test here — let every request through.
vi.mock("$lib/server/ratelimit", () => ({
  importKoboLimiter: {},
  enforceRateLimit: async () => null,
}));

// Stub the import processing so the success path is reached without the route's
// supabase mock having to satisfy processKoboImport's many queries.
const processKoboImport = vi.fn(async () => ({ books: 1, imported: 2 }));
vi.mock("$lib/server/import/kobo", () => ({
  validateKoboPayload: () => ({ items: [], complete: true }),
  processKoboImport,
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
        Authorization: "Bearer sk_device_timestamp_test_token",
      },
      body: JSON.stringify({ items: [], complete: true }),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/import/kobo — device timestamp bump (web #541)", () => {
  beforeEach(() => {
    supabase._results.clear();
    supabase._updateCalls.length = 0;
    processKoboImport.mockClear();
    // Authenticated, non-revoked device.
    supabase._results.set("devices.select", {
      data: {
        id: VALID_DEVICE_ID,
        user_id: VALID_USER_ID,
        hardware_id: "hw-001",
        name: "Synced Kobo",
        revoked_at: null,
      },
      error: null,
    });
  });

  it("updates devices.last_synced_at + last_used_at after a successful import", async () => {
    const res = await POST(buildEvent());
    expect(res.status).toBe(200);
    expect(processKoboImport).toHaveBeenCalledOnce();

    const deviceUpdates = supabase._updateCalls.filter(
      (c) => c.table === "devices",
    );
    expect(deviceUpdates).toHaveLength(1);

    const payload = deviceUpdates[0].payload as {
      last_synced_at?: string;
      last_used_at?: string;
    };
    expect(typeof payload.last_synced_at).toBe("string");
    expect(typeof payload.last_used_at).toBe("string");
    // Both stamped from the same instant.
    expect(payload.last_synced_at).toBe(payload.last_used_at);
    // A real ISO-8601 instant, not a placeholder.
    expect(Number.isNaN(Date.parse(payload.last_synced_at!))).toBe(false);
  });

  it("still returns 200 when the timestamp bump fails (import already committed)", async () => {
    // The import succeeded and committed; a metadata-write blip must not turn a
    // good import into a 500 (which would make the agent re-POST needlessly).
    supabase._results.set("devices.update", {
      data: null,
      error: { message: "timestamp write failed" },
    });

    const res = await POST(buildEvent());
    expect(res.status).toBe(200);
  });
});
