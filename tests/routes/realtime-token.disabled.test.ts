import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

// Asserts the route returns 503 realtime_disabled when the JWT signing env
// vars aren't configured — the self-host default before an operator
// generates a keypair. Lives in its own file for module-cache isolation
// (vi.mock hoists above imports; can't be reused across suites with
// different env values).

vi.mock("$env/dynamic/private", () => ({
  env: {
    // All four LIBRITO_JWT_* deliberately absent.
  },
}));

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://test-proj.supabase.co",
  PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-not-a-real-jwt",
}));

const authMock = vi.fn();
vi.mock("$lib/server/auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticateDevice: (...args: unknown[]) => authMock(...args),
  };
});

const limitMock = vi.fn();
const userLimitMock = vi.fn();
vi.mock("$lib/server/ratelimit", async () => {
  const { passThroughSafeLimit } = await import("../helpers");
  return {
    realtimeTokenLimiter: { limit: (...args: unknown[]) => limitMock(...args) },
    realtimeTokenUserLimiter: {
      limit: (...args: unknown[]) => userLimitMock(...args),
    },
    safeLimit: passThroughSafeLimit,
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } = await import("../../src/routes/api/realtime-token/+server");

function buildRequest(headers: Record<string, string> = {}) {
  return {
    request: new Request("http://x/api/realtime-token", {
      method: "POST",
      headers,
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/realtime-token (env not configured)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authMock.mockReset();
    limitMock.mockReset();
    userLimitMock.mockReset();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    userLimitMock.mockResolvedValue({
      success: true,
      reset: Date.now() + 3_600_000,
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("503 realtime_disabled when LIBRITO_JWT_* env vars are unset", async () => {
    authMock.mockResolvedValueOnce({
      device: {
        id: "22222222-2222-2222-2222-222222222222",
        userId: "11111111-1111-1111-1111-111111111111",
        hardwareId: "hw",
        name: "n",
      },
    });

    const res = await POST(
      buildRequest({ Authorization: "Bearer sk_device_xxx" }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("realtime_disabled");
    expect(body.message).toMatch(/not configured/i);

    // Bearer auth must still succeed before config is checked — confirms
    // the disabled response is feature-scoped, not a fallback for any
    // failure mode.
    expect(authMock).toHaveBeenCalledOnce();

    const call = errorSpy.mock.calls.find(
      (c) => c[0] === "realtime.token_disabled",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      hasPrivateKey: false,
    });
  });
});
