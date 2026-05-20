import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

// Asserts the route distinguishes invalid-shape JWK from valid-shape +
// runtime crypto failure. A wrong-shape JWK (RSA instead of EC, missing d,
// wrong alg) used to reach importJWK in mintRealtimeToken and surface as a
// generic 500 server_error, indistinguishable in Sentry from a transient
// crypto issue. Now the shape check sits between JSON.parse and the cast,
// returning 500 server_misconfigured + realtime.jwk_shape_invalid log.

const WRONG_SHAPE_JWK = JSON.stringify({
  // Valid JSON, but missing `d` and using RSA — fails the kty/alg/d guard.
  kty: "RSA",
  alg: "RS256",
  n: "0vx7...truncated",
  e: "AQAB",
});

vi.mock("$env/dynamic/private", () => ({
  env: {
    LIBRITO_JWT_PRIVATE_KEY_JWK: WRONG_SHAPE_JWK,
  },
}));

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://test-proj.supabase.co",
  PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-not-a-real-jwt",
}));

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
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
vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  return {
    ...actual,
    realtimeTokenLimiter: {
      ...actual.realtimeTokenLimiter,
      limit: (...args: unknown[]) => limitMock(...args),
    },
    realtimeTokenUserLimiter: {
      ...actual.realtimeTokenUserLimiter,
      limit: (...args: unknown[]) => userLimitMock(...args),
    },
  };
});

// Spy on mintRealtimeToken so we can confirm the route short-circuits at
// shape validation without ever invoking the signer.
const mintSpy = vi.fn();
vi.mock("$lib/server/realtime", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mintRealtimeToken: (...args: unknown[]) => mintSpy(...args),
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } = await import("../../src/routes/api/realtime-token/+server");
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";

function buildRequest(headers: Record<string, string> = {}) {
  return {
    request: new Request("http://x/api/realtime-token", {
      method: "POST",
      headers,
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/realtime-token (malformed JWK shape)", () => {
  let logWrites: Record<string, unknown>[];

  beforeEach(() => {
    authMock.mockReset();
    limitMock.mockReset();
    userLimitMock.mockReset();
    mintSpy.mockReset();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    userLimitMock.mockResolvedValue({
      success: true,
      reset: Date.now() + 3_600_000,
    });
    logWrites = [];
    __setTestDestination((line) => logWrites.push(JSON.parse(line)));
  });
  afterEach(() => {
    __resetTestDestination();
  });

  it("returns 500 server_misconfigured + jwk_shape_invalid log when JWK is valid JSON but wrong shape", async () => {
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
    expect(body.error).toBe("server_misconfigured");

    // Shape-invalid path must not reach the signer (or the per-route
    // rate-limit budget — guard sits between parse and limiter).
    expect(mintSpy).not.toHaveBeenCalled();

    expect(logWrites).toContainEqual(
      expect.objectContaining({
        event: "realtime.jwk_shape_invalid",
      }),
    );
  });

  it("distinguishes shape-invalid (server_misconfigured) from runtime mint failure (server_error)", async () => {
    // The mint-failure path lives in realtime-token.error.test.ts and
    // returns server_error. This assertion locks in that the two failure
    // modes carry different machine error codes — operators reading
    // Sentry / logs must be able to tell config drift from transient
    // crypto failures.
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
    const body = await res.json();
    expect(body.error).toBe("server_misconfigured");
    expect(body.error).not.toBe("server_error");
  });
});
