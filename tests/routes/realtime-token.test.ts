import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jwtVerify } from "jose";
import { createMockSupabase } from "../helpers";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-padding";

vi.mock("$env/static/private", () => ({
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
}));

const authMock = vi.fn();
vi.mock("$lib/server/auth", () => ({
  authenticateDevice: (...args: unknown[]) => authMock(...args),
}));

const limitMock = vi.fn();
vi.mock("$lib/server/ratelimit", () => ({
  realtimeTokenLimiter: { limit: (...args: unknown[]) => limitMock(...args) },
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

describe("POST /api/realtime-token (WS-RT)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authMock.mockReset();
    limitMock.mockReset();
    supabase._results.clear();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("401 missing_token when Authorization header absent", async () => {
    authMock.mockResolvedValueOnce({ error: "missing_token" });
    const res = await POST(buildRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("missing_token");
    expect(body.message).toMatch(/Bearer token required/);
  });

  it("401 invalid_token when device lookup misses", async () => {
    authMock.mockResolvedValueOnce({ error: "invalid_token" });
    const res = await POST(
      buildRequest({ Authorization: "Bearer sk_device_unknown" }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_token");
  });

  it("401 token_revoked when devices.revoked_at is non-null", async () => {
    authMock.mockResolvedValueOnce({ error: "token_revoked" });
    const res = await POST(
      buildRequest({ Authorization: "Bearer sk_device_revoked" }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("token_revoked");
    expect(body.message).toMatch(/Re-pair the device/);
  });

  it("429 rate_limited with Retry-After header when limiter denies", async () => {
    authMock.mockResolvedValueOnce({
      device: { id: "d-1", userId: "u-1", hardwareId: "hw", name: "n" },
    });
    limitMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
    });
    const res = await POST(
      buildRequest({ Authorization: "Bearer sk_device_xxx" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("200 happy path returns {token, expiresIn:86400} with valid JWT claims", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const deviceId = "22222222-2222-2222-2222-222222222222";
    authMock.mockResolvedValueOnce({
      device: { id: deviceId, userId, hardwareId: "hw", name: "n" },
    });
    limitMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
    });

    const res = await POST(
      buildRequest({ Authorization: "Bearer sk_device_xxx" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresIn: number };
    expect(body.expiresIn).toBe(86400);
    expect(typeof body.token).toBe("string");

    const { payload } = await jwtVerify(
      body.token,
      new TextEncoder().encode(TEST_JWT_SECRET),
      { audience: "authenticated" },
    );
    expect(payload.sub).toBe(userId);
    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
    expect(payload.device_id).toBe(deviceId);
    expect((payload.exp as number) - (payload.iat as number)).toBe(86400);
  });

  it("emits realtime.token_issued log on success", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const deviceId = "22222222-2222-2222-2222-222222222222";
    authMock.mockResolvedValueOnce({
      device: { id: deviceId, userId, hardwareId: "hw", name: "n" },
    });
    limitMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
    });

    await POST(buildRequest({ Authorization: "Bearer sk_device_xxx" }));

    const call = infoSpy.mock.calls.find(
      (c) => c[0] === "realtime.token_issued",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      userId,
      deviceId,
      expiresIn: 86400,
    });
  });

  it("500 server_error with realtime.token_mint_failed log when signing throws", async () => {
    // Minting throws when the TextEncoder.encode runs over a non-string secret.
    // We force the failure path by stubbing the realtime module via dynamic mock.
    vi.resetModules();
    vi.doMock("$lib/server/realtime", () => ({
      mintRealtimeToken: vi.fn(async () => {
        throw new Error("simulated jose failure");
      }),
      REALTIME_TOKEN_TTL_SECONDS: 86400,
    }));
    const fresh = await import("../../src/routes/api/realtime-token/+server");

    authMock.mockResolvedValueOnce({
      device: {
        id: "22222222-2222-2222-2222-222222222222",
        userId: "11111111-1111-1111-1111-111111111111",
        hardwareId: "hw",
        name: "n",
      },
    });
    limitMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
    });

    const res = await fresh.POST(
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

    vi.doUnmock("$lib/server/realtime");
    vi.resetModules();
  });
});
