import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { jwtVerify, importJWK } from "jose";
import { createMockSupabase } from "../helpers";
import {
  DEV_STANDBY_JWK,
  DEV_STANDBY_JWK_STR,
  DEV_KID,
} from "../fixtures/dev-jwk";

const TEST_SUPABASE_URL = "https://test-proj.supabase.co";

vi.mock("$env/dynamic/private", () => ({
  env: {
    LIBRITO_JWT_PRIVATE_KEY_JWK: DEV_STANDBY_JWK_STR,
  },
}));

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: TEST_SUPABASE_URL,
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
vi.mock("$lib/server/ratelimit", () => ({
  realtimeTokenLimiter: { limit: (...args: unknown[]) => limitMock(...args) },
  realtimeTokenUserLimiter: {
    limit: (...args: unknown[]) => userLimitMock(...args),
  },
  // Pass-through wrapper. The route now calls safeLimit(limiter, key, label);
  // funnel back to the existing limit-mock spies so per-test denials still
  // assert correctly. Catch surfaces fail-open semantics for any throw cases.
  safeLimit: async (
    limiter: {
      limit: (k: string) => Promise<{ success: boolean; reset: number }>;
    },
    key: string,
  ) => {
    try {
      return await limiter.limit(key);
    } catch {
      return { success: true, reset: 0 };
    }
  },
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

describe("POST /api/realtime-token (standby-key ES256)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    authMock.mockReset();
    limitMock.mockReset();
    userLimitMock.mockReset();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    userLimitMock.mockResolvedValue({
      success: true,
      reset: Date.now() + 3_600_000,
    });
    supabase._results.clear();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fire-and-forget JWKS check inside mintRealtimeToken — stub global
    // fetch so the test environment doesn't hit the network.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ keys: [{ kid: DEV_KID }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    fetchSpy.mockRestore();
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

  it("429 rate_limited with Retry-After header when per-device limiter denies", async () => {
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

  it("429 rate_limited when per-user limiter denies (re-pair-loop bypass)", async () => {
    authMock.mockResolvedValueOnce({
      device: { id: "d-fresh", userId: "u-1", hardwareId: "hw", name: "n" },
    });
    userLimitMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 600_000,
    });
    const res = await POST(
      buildRequest({ Authorization: "Bearer sk_device_xxx" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("200 happy path returns {token, expiresIn:86400} with valid ES256 JWT claims", async () => {
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
    const body = (await res.json()) as {
      token: string;
      expiresIn: number;
      realtimeUrl: string;
      anonKey: string;
    };
    expect(body.expiresIn).toBe(86400);
    expect(typeof body.token).toBe("string");
    expect(body.realtimeUrl.startsWith("wss://")).toBe(true);
    expect(body.realtimeUrl.endsWith("/realtime/v1/websocket")).toBe(true);
    expect(typeof body.anonKey).toBe("string");
    expect(body.anonKey.length).toBeGreaterThan(0);
    expect(body.anonKey).not.toBe(body.realtimeUrl);

    const { d, key_ops, ...publicJwk } = DEV_STANDBY_JWK;
    const publicKey = await importJWK(publicJwk, "ES256");
    const { payload, protectedHeader } = await jwtVerify(
      body.token,
      publicKey,
      {
        audience: "authenticated",
      },
    );
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe(DEV_KID);
    expect(payload.iss).toBe(`${TEST_SUPABASE_URL}/auth/v1`);
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
});
