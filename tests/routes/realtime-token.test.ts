import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jwtVerify, importJWK } from "jose";
import { createMockSupabase } from "../helpers";

// Static ES256 keypair fixture. vi.mock hoists above imports, so we can't
// generate at runtime — embed once. The matching public JWK is asserted
// below to verify signatures end-to-end.
const TEST_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgyN0xVvKw1GY7IOvW
onn5PQ1S8EupPoRY93+/trVs8kihRANCAATAEPCWCqGfnZLx/pq1WAOw5F/5DRWu
3s7NNUUGimo6aalkpVIseeUiI3ltvp6arS35IpDtrYlveIzJtN28ygk8
-----END PRIVATE KEY-----
`;
const TEST_JWK_STR =
  '{"kty":"EC","x":"wBDwlgqhn52S8f6atVgDsORf-Q0Vrt7OzTVFBopqOmk","y":"qWSlUix55SIjeW2-npqtLfkikO2tiW94jMm03bzKCTw","crv":"P-256","kid":"test-kid-fixture","use":"sig","alg":"ES256"}';
const TEST_KID = "test-kid-fixture";
const TEST_ISSUER = "https://test.librito.io";

vi.mock("$env/dynamic/private", () => ({
  env: {
    LIBRITO_JWT_PRIVATE_KEY_PEM: TEST_PEM,
    LIBRITO_JWT_PUBLIC_KEY_JWK: TEST_JWK_STR,
    LIBRITO_JWT_KID: TEST_KID,
    LIBRITO_JWT_ISSUER: TEST_ISSUER,
  },
}));

// Pin a prod-shaped Supabase URL so realtimeUrl assertions don't depend on
// whatever .env provides (local dev has http://127.0.0.1:54321 → ws://, not
// wss://).
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
vi.mock("$lib/server/ratelimit", () => ({
  realtimeTokenLimiter: { limit: (...args: unknown[]) => limitMock(...args) },
  realtimeTokenUserLimiter: {
    limit: (...args: unknown[]) => userLimitMock(...args),
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

describe("POST /api/realtime-token (WS-RT, ES256)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authMock.mockReset();
    limitMock.mockReset();
    userLimitMock.mockReset();
    // Default both limiters to allow; tests that exercise denial override
    // with mockResolvedValueOnce so the rest of the suite stays terse.
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    userLimitMock.mockResolvedValue({
      success: true,
      reset: Date.now() + 3_600_000,
    });
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
    // Per-device cap clears (fresh device.id), per-user cap denies — the
    // re-pair-loop bypass scenario the user limiter exists to catch.
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

    expect(typeof body.realtimeUrl).toBe("string");
    expect(body.realtimeUrl.length).toBeGreaterThan(0);
    expect(body.realtimeUrl.startsWith("wss://")).toBe(true);
    expect(body.realtimeUrl.endsWith("/realtime/v1/websocket")).toBe(true);
    expect(typeof body.anonKey).toBe("string");
    expect(body.anonKey.length).toBeGreaterThan(0);
    // anonKey should not equal the realtime URL (catches arg-order swap).
    expect(body.anonKey).not.toBe(body.realtimeUrl);

    const publicKey = await importJWK(JSON.parse(TEST_JWK_STR), "ES256");
    const { payload, protectedHeader } = await jwtVerify(
      body.token,
      publicKey,
      {
        audience: "authenticated",
        issuer: TEST_ISSUER,
      },
    );
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe(TEST_KID);
    expect(payload.iss).toBe(TEST_ISSUER);
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

  // The 500 server_error path is exercised in realtime-token.error.test.ts.
  // Splitting into its own file gives true module-cache isolation under any
  // test order: vitest 3 has no isolateModulesAsync, so file boundaries are
  // the cleanest seam to mock $lib/server/realtime without leakage.
});
