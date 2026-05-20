// tests/routes/pair-request.test.ts
//
// Wiring guarantees the unit-tested business logic in
// src/lib/server/pairing.ts cannot enforce alone:
//
// 1. The route MUST gate on BOTH per-IP and per-hardwareId limiters, in
//    that order. Per-IP first bounds body-parsing cost for IP-bound
//    floods; per-hardware second caps damage when an attacker rotates
//    IPs to bypass the per-IP cap. Removing the per-hardware check would
//    reopen the rotation bypass surfaced in issue #285.
// 2. Both limiters are fail-closed — an Upstash blip must not collapse
//    the defense-in-depth invariant on a credential-mint path. Asserted
//    via 503 + ratelimit.policy.test.ts label/failMode snapshot.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAIL_CLOSED_RETRY_AFTER_SEC } from "$lib/server/ratelimit.constants";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

vi.mock("$lib/server/pairing", () => ({
  requestPairingCode: vi.fn(async () => ({
    code: "482901",
    pairingId: "pairing-uuid",
    expiresIn: 300,
  })),
}));

// Substitute only the limiter exports — `enforceRateLimit` and the rest
// of the module stay real so the route exercises the production
// safeLimit + jsonError path end-to-end.
vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  const allow = () =>
    vi.fn(async () => ({
      success: true,
      reset: Date.now() + 60_000,
      limit: 99,
      remaining: 98,
      pending: Promise.resolve(),
    }));
  return {
    ...actual,
    pairRequestLimiter: { ...actual.pairRequestLimiter, limit: allow() },
    pairRequestPerHardwareLimiter: {
      ...actual.pairRequestPerHardwareLimiter,
      limit: allow(),
    },
  };
});

vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => ({}),
}));

const { POST } = await import("../../src/routes/api/pair/request/+server");
const { requestPairingCode } = await import("$lib/server/pairing");
const requestSpy = requestPairingCode as unknown as ReturnType<typeof vi.fn>;

const HW_ID = "550e8400-e29b-41d4-a716-446655440000";

function buildEvent(body: unknown, ip = "203.0.113.7") {
  return {
    request: new Request("http://x/api/pair/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    getClientAddress: () => ip,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  requestSpy.mockClear();
});

describe("POST /api/pair/request — layered rate limits", () => {
  it("returns 200 and forwards hardwareId when both limiters allow", async () => {
    const res = await POST(buildEvent({ hardwareId: HW_ID }));
    expect(res.status).toBe(200);
    expect(requestSpy).toHaveBeenCalledWith(expect.any(Object), HW_ID);
  });

  it("checks per-IP first, then per-hardwareId; both keyed correctly", async () => {
    const { pairRequestLimiter, pairRequestPerHardwareLimiter } =
      await import("$lib/server/ratelimit");
    const ipSpy = pairRequestLimiter.limit as ReturnType<typeof vi.fn>;
    const hwSpy = pairRequestPerHardwareLimiter.limit as ReturnType<
      typeof vi.fn
    >;
    ipSpy.mockClear();
    hwSpy.mockClear();

    await POST(buildEvent({ hardwareId: HW_ID }, "198.51.100.42"));

    expect(ipSpy).toHaveBeenCalledWith("198.51.100.42");
    expect(hwSpy).toHaveBeenCalledWith(HW_ID);
    // Layer order: per-IP fires first.
    expect(ipSpy.mock.invocationCallOrder[0]).toBeLessThan(
      hwSpy.mock.invocationCallOrder[0],
    );
  });

  it("returns 429 from per-IP layer; per-hardware not consulted", async () => {
    const { pairRequestLimiter, pairRequestPerHardwareLimiter } =
      await import("$lib/server/ratelimit");
    const ipSpy = pairRequestLimiter.limit as ReturnType<typeof vi.fn>;
    const hwSpy = pairRequestPerHardwareLimiter.limit as ReturnType<
      typeof vi.fn
    >;
    hwSpy.mockClear();
    ipSpy.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
      limit: 3,
      remaining: 0,
      pending: Promise.resolve(),
    });

    const res = await POST(buildEvent({ hardwareId: HW_ID }));
    expect(res.status).toBe(429);
    // Sliding-window decrement against the per-hardware bucket must not
    // happen when per-IP already denied — otherwise an IP-bound attacker
    // drains the legitimate device's per-hardware budget for free.
    expect(hwSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("returns 429 from per-hardware layer when per-IP allows", async () => {
    const { pairRequestPerHardwareLimiter } =
      await import("$lib/server/ratelimit");
    const hwSpy = pairRequestPerHardwareLimiter.limit as ReturnType<
      typeof vi.fn
    >;
    hwSpy.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
      limit: 5,
      remaining: 0,
      pending: Promise.resolve(),
    });

    const res = await POST(buildEvent({ hardwareId: HW_ID }));
    expect(res.status).toBe(429);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("returns 503 when per-IP limiter throws (fail-closed)", async () => {
    const { pairRequestLimiter } = await import("$lib/server/ratelimit");
    (
      pairRequestLimiter.limit as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await POST(buildEvent({ hardwareId: HW_ID }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(
      String(FAIL_CLOSED_RETRY_AFTER_SEC),
    );
    expect((await res.json()).error).toBe("rate_limit_unavailable");
  });

  it("returns 503 when per-hardware limiter throws (fail-closed)", async () => {
    const { pairRequestPerHardwareLimiter } =
      await import("$lib/server/ratelimit");
    (
      pairRequestPerHardwareLimiter.limit as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await POST(buildEvent({ hardwareId: HW_ID }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("rate_limit_unavailable");
  });

  it("rejects missing hardwareId BEFORE per-hardware check (per-IP only)", async () => {
    const { pairRequestPerHardwareLimiter } =
      await import("$lib/server/ratelimit");
    const hwSpy = pairRequestPerHardwareLimiter.limit as ReturnType<
      typeof vi.fn
    >;
    hwSpy.mockClear();

    const res = await POST(buildEvent({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(hwSpy).not.toHaveBeenCalled();
  });

  it("rejects non-UUID hardwareId BEFORE per-hardware check", async () => {
    const { pairRequestPerHardwareLimiter } =
      await import("$lib/server/ratelimit");
    const hwSpy = pairRequestPerHardwareLimiter.limit as ReturnType<
      typeof vi.fn
    >;
    hwSpy.mockClear();

    const res = await POST(buildEvent({ hardwareId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(hwSpy).not.toHaveBeenCalled();
  });
});
