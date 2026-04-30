import { describe, it, expect, vi, afterEach } from "vitest";

// $env/static/private is unavailable under vitest without mocking. Stub
// before importing the module under test so module-load doesn't throw.
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

import { safeLimit } from "$lib/server/ratelimit";
import type { Ratelimit } from "@upstash/ratelimit";

function fakeLimiter(
  impl: () => Promise<{ success: boolean; reset: number }>,
): Ratelimit {
  return { limit: vi.fn(impl) } as unknown as Ratelimit;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeLimit", () => {
  it("returns the limiter's result on success", async () => {
    const limiter = fakeLimiter(async () => ({
      success: true,
      reset: 1234,
    }));
    const result = await safeLimit(limiter, "user-1", "test:limiter");
    expect(result).toEqual({ success: true, reset: 1234 });
  });

  it("returns the limiter's denial on rate-limit hit", async () => {
    const limiter = fakeLimiter(async () => ({
      success: false,
      reset: 5678,
    }));
    const result = await safeLimit(limiter, "user-1", "test:limiter");
    expect(result).toEqual({ success: false, reset: 5678 });
  });

  it("fails open with success=true on Upstash error and logs the throw", async () => {
    // Audit P6: rate limits are an availability guard, not a security
    // boundary. An Upstash outage must not turn into a 504 storm — the
    // request is allowed to proceed; downstream business logic still
    // enforces the actual security invariants.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await safeLimit(limiter, "user-1", "test:limiter");

    expect(result).toEqual({ success: true, reset: 0 });
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.upstash_unreachable",
      expect.objectContaining({
        limiter: "test:limiter",
        error: "ECONNREFUSED",
        stack: expect.stringContaining("ECONNREFUSED"),
      }),
    );
  });

  it("does not log the raw rate-limit key (PII / credential hygiene)", async () => {
    // For unauth pair routes the key is the client IP; for `pair:claim`
    // the key is `${pairingCode}:${ip}`. Logging it on every Upstash
    // failure would write PII (and a 5-min credential, in the claim case)
    // into Vercel log retention. The label is enough to correlate.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter(async () => {
      throw new Error("upstash boom");
    });

    await safeLimit(limiter, "203.0.113.7", "pair:request");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.key).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("203.0.113.7");
  });
});
