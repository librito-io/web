import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// $env/static/private is unavailable under vitest without mocking. Stub
// before importing the module under test so module-load doesn't throw.
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

import {
  createLimiter,
  enforceRateLimit,
  enforceRateLimits,
  type RateLimiter,
  type LimitResult,
  type FailMode,
} from "$lib/server/ratelimit";
import { Ratelimit } from "@upstash/ratelimit";

function fakeLimiter(
  failMode: FailMode,
  impl: () => Promise<LimitResult>,
): RateLimiter {
  return {
    limit: vi.fn(impl),
    label: `test:${failMode}`,
    failMode,
  };
}

function fullLimitResult(over: Partial<LimitResult> = {}): LimitResult {
  return {
    success: true,
    limit: 5,
    remaining: 4,
    reset: Date.now() + 60_000,
    pending: Promise.resolve(),
    ...over,
  } as LimitResult;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createLimiter", () => {
  it("derives label from prefix by stripping the rl: namespace", () => {
    const limiter = createLimiter({
      window: Ratelimit.slidingWindow(5, "5m"),
      prefix: "rl:pair:claim",
      failMode: "closed",
    });
    expect(limiter.label).toBe("pair:claim");
    expect(limiter.failMode).toBe("closed");
    expect(typeof limiter.limit).toBe("function");
  });

  it("throws if prefix doesn't start with rl:", () => {
    expect(() =>
      createLimiter({
        window: Ratelimit.slidingWindow(1, "1s"),
        prefix: "pair:request",
        failMode: "open",
      }),
    ).toThrow(/prefix must start with "rl:"/);
  });

  it("requires explicit failMode (no default)", () => {
    const open = createLimiter({
      window: Ratelimit.slidingWindow(1, "1s"),
      prefix: "rl:test:open",
      failMode: "open",
    });
    const closed = createLimiter({
      window: Ratelimit.slidingWindow(1, "1s"),
      prefix: "rl:test:closed",
      failMode: "closed",
    });
    expect(open.failMode).toBe("open");
    expect(closed.failMode).toBe("closed");
  });
});

describe("enforceRateLimit — happy paths", () => {
  it("returns null when limiter allows", async () => {
    const limiter = fakeLimiter("open", async () =>
      fullLimitResult({ success: true }),
    );
    const res = await enforceRateLimit(limiter, "key-1", "Too many requests");
    expect(res).toBeNull();
  });

  it("returns 429 with Retry-After when limiter denies", async () => {
    const reset = Date.now() + 12_000;
    const limiter = fakeLimiter("open", async () =>
      fullLimitResult({ success: false, reset }),
    );
    const res = await enforceRateLimit(limiter, "key-1", "Too many requests");
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBe("12");
    const body = await res!.json();
    expect(body).toEqual({
      error: "rate_limited",
      message: "Too many requests",
    });
  });

  it("Retry-After is at least 1 even if reset is in the past", async () => {
    const limiter = fakeLimiter("open", async () =>
      fullLimitResult({ success: false, reset: Date.now() - 5_000 }),
    );
    const res = await enforceRateLimit(limiter, "key-1", "Too many requests");
    expect(res!.headers.get("Retry-After")).toBe("1");
  });
});

describe("enforceRateLimit — fail-closed under Upstash failure", () => {
  it("returns 503 with Retry-After: 30 when limiter throws and failMode is closed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("closed", async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await enforceRateLimit(limiter, "key-1", "Too many requests");
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(503);
    expect(res!.headers.get("Retry-After")).toBe("30");
    const body = await res!.json();
    expect(body).toEqual({
      error: "rate_limit_unavailable",
      message: "Service temporarily unavailable. Please retry shortly.",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.upstash_unreachable",
      expect.objectContaining({
        limiter: "test:closed",
        failMode: "closed",
      }),
    );
  });

  it("returns null (allows request) when limiter throws and failMode is open", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("open", async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await enforceRateLimit(limiter, "key-1", "Too many requests");
    expect(res).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.upstash_unreachable",
      expect.objectContaining({
        limiter: "test:open",
        failMode: "open",
      }),
    );
  });
});

describe("safeLimit — programmer-error rethrow", () => {
  it.each([
    ["RangeError", () => new RangeError("array length")],
    ["SyntaxError", () => new SyntaxError("unexpected token")],
    ["ReferenceError", () => new ReferenceError("foo is not defined")],
  ])("rethrows %s instead of fail-open/closed", async (_name, mkErr) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("open", async () => {
      throw mkErr();
    });
    await expect(enforceRateLimit(limiter, "key-1", "msg")).rejects.toThrow(
      mkErr().constructor as new (...args: unknown[]) => Error,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("safeLimit — unexpected throws are logged distinctly", () => {
  it("logs ratelimit.unexpected_throw with errorName for non-transport Error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    class CustomError extends Error {
      constructor() {
        super("custom boom");
        this.name = "CustomError";
      }
    }
    const limiter = fakeLimiter("open", async () => {
      throw new CustomError();
    });
    const res = await enforceRateLimit(limiter, "key-1", "msg");
    expect(res).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.unexpected_throw",
      expect.objectContaining({
        limiter: "test:open",
        errorName: "CustomError",
        error: "custom boom",
      }),
    );
  });
});

describe("safeLimit — timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("logs ratelimit.upstash_timeout and applies failMode after 1500ms hang", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("closed", () => new Promise(() => {}));
    const promise = enforceRateLimit(limiter, "key-1", "msg");
    await vi.advanceTimersByTimeAsync(1501);
    const res = await promise;
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.upstash_timeout",
      expect.objectContaining({
        limiter: "test:closed",
        failMode: "closed",
        timeoutMs: 1500,
      }),
    );
  });

  it("does not leak timers under happy path", async () => {
    vi.useFakeTimers();
    const limiter = fakeLimiter("open", async () =>
      fullLimitResult({ success: true }),
    );
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      await enforceRateLimit(limiter, `k-${i}`, "msg");
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("safeLimit — log payload hygiene (no PII / credentials)", () => {
  // For unauth pair routes the key is the client IP; for `pair:claim` the
  // key is `${pairingCode}:${ip}`. None of the three log paths must write
  // the key into log retention.
  const SENSITIVE_KEY = "code-abc123:203.0.113.7";

  it("upstash_unreachable log omits key", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("open", async () => {
      throw new Error("ECONNREFUSED");
    });
    await enforceRateLimit(limiter, SENSITIVE_KEY, "msg");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.key).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(SENSITIVE_KEY);
  });

  it("unexpected_throw log omits key", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("open", async () => {
      throw new Error("custom boom");
    });
    await enforceRateLimit(limiter, SENSITIVE_KEY, "msg");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.key).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(SENSITIVE_KEY);
  });

  it("upstash_timeout log omits key", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("closed", () => new Promise(() => {}));
    const promise = enforceRateLimit(limiter, SENSITIVE_KEY, "msg");
    await vi.advanceTimersByTimeAsync(1501);
    await promise;
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.key).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(SENSITIVE_KEY);
  });
});

describe("enforceRateLimits — multi-limiter precedence", () => {
  it("returns null when all limiters allow", async () => {
    const a = fakeLimiter("closed", async () =>
      fullLimitResult({ success: true }),
    );
    const b = fakeLimiter("closed", async () =>
      fullLimitResult({ success: true }),
    );
    const res = await enforceRateLimits(
      [
        { limiter: a, key: "k-a" },
        { limiter: b, key: "k-b" },
      ],
      "msg",
    );
    expect(res).toBeNull();
  });

  it("returns 429 with max(reset) when one limiter denies", async () => {
    const reset1 = Date.now() + 5_000;
    const reset2 = Date.now() + 11_000;
    const a = fakeLimiter("closed", async () =>
      fullLimitResult({ success: false, reset: reset1 }),
    );
    const b = fakeLimiter("closed", async () =>
      fullLimitResult({ success: false, reset: reset2 }),
    );
    const res = await enforceRateLimits(
      [
        { limiter: a, key: "k-a" },
        { limiter: b, key: "k-b" },
      ],
      "msg",
    );
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBe("11");
  });

  it("returns 503 when any limiter fails closed (overrides denials)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = fakeLimiter("closed", async () => {
      throw new Error("ECONNREFUSED");
    });
    const b = fakeLimiter("closed", async () =>
      fullLimitResult({ success: false, reset: Date.now() + 60_000 }),
    );
    const res = await enforceRateLimits(
      [
        { limiter: a, key: "k-a" },
        { limiter: b, key: "k-b" },
      ],
      "msg",
    );
    expect(res!.status).toBe(503);
    expect(res!.headers.get("Retry-After")).toBe("30");
  });

  it("throws on empty array", async () => {
    await expect(enforceRateLimits([], "msg")).rejects.toThrow(/non-empty/);
  });
});
