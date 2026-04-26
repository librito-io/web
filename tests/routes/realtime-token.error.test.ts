import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

// This file isolates the realtime-token mint-failure path. It mocks
// $lib/server/realtime so mintRealtimeToken throws, then asserts the route
// handler maps that to a 500 + structured error log. Living in its own file
// (rather than mid-suite vi.doMock) is the cleanest module-cache isolation
// available under vitest 3 (no isolateModulesAsync).

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-padding";

vi.mock("$env/static/private", () => ({
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
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
vi.mock("$lib/server/ratelimit", () => ({
  realtimeTokenLimiter: { limit: (...args: unknown[]) => limitMock(...args) },
  realtimeTokenUserLimiter: {
    limit: (...args: unknown[]) => userLimitMock(...args),
  },
}));

vi.mock("$lib/server/realtime", () => ({
  mintRealtimeToken: vi.fn(async () => {
    throw new Error("simulated jose failure");
  }),
  REALTIME_TOKEN_TTL_SECONDS: 86400,
}));

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

describe("POST /api/realtime-token (mint failure path)", () => {
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

  it("500 server_error with realtime.token_mint_failed log when signing throws", async () => {
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
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("server_error");

    const call = errorSpy.mock.calls.find(
      (c) => c[0] === "realtime.token_mint_failed",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
    });
  });
});
