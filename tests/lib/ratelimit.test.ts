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
  safeLimit,
  type RateLimiter,
  type LimitResult,
  type FailMode,
  type SafeOutcome,
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

  // TG2: timeout interaction in the multi-limiter path. After T1 the
  // sequencing means a hang on limiter A short-circuits before limiter B
  // is invoked — this test pins that semantics so a future Promise.all
  // re-introduction can't slip through silently.
  it("returns 503 when the first sequenced limiter times out and never invokes the second", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const aImpl = vi.fn(() => new Promise<LimitResult>(() => {}));
    const bImpl = vi.fn(async () => fullLimitResult({ success: true }));
    const a: RateLimiter = { limit: aImpl, label: "first", failMode: "closed" };
    const b: RateLimiter = {
      limit: bImpl,
      label: "second",
      failMode: "closed",
    };
    const promise = enforceRateLimits(
      [
        { limiter: a, key: "k-a" },
        { limiter: b, key: "k-b" },
      ],
      "msg",
    );
    await vi.advanceTimersByTimeAsync(1501);
    const res = await promise;
    expect(res!.status).toBe(503);
    expect(res!.headers.get("Retry-After")).toBe("30");
    expect(bImpl).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.upstash_timeout",
      expect.objectContaining({ limiter: "first" }),
    );
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

describe("safeLimit — discriminated-union outcome shape", () => {
  // Contract test: future readers of `SafeOutcome` should see that:
  //   - upstream success/deny → kind:"ok" carrying the real LimitResult
  //   - upstream throw + failMode:"open"   → kind:"failOpen"
  //   - upstream throw + failMode:"closed" → kind:"failClosed"
  // No synthetic LimitResult ever stands in for a fail-open allow.

  it("returns kind:'ok' with the real LimitResult on upstream success", async () => {
    const allowed = fullLimitResult({ success: true, limit: 5, remaining: 4 });
    const limiter = fakeLimiter("open", async () => allowed);
    const outcome = await safeLimit(limiter, "k");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result).toBe(allowed);
    }
  });

  it("returns kind:'ok' with the real LimitResult on upstream deny", async () => {
    const denied = fullLimitResult({
      success: false,
      reset: Date.now() + 1000,
    });
    const limiter = fakeLimiter("closed", async () => denied);
    const outcome = await safeLimit(limiter, "k");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result.success).toBe(false);
    }
  });

  it("returns kind:'failOpen' with the limiter label when fail-open limiter throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("open", async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await safeLimit(limiter, "k");
    expect(outcome).toEqual({ kind: "failOpen", label: "test:open" });
  });

  it("returns kind:'failClosed' with the limiter label when fail-closed limiter throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = fakeLimiter("closed", async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await safeLimit(limiter, "k");
    expect(outcome).toEqual({ kind: "failClosed", label: "test:closed" });
  });

  it("SafeOutcome is exported and assignable to the three documented variants", () => {
    const ok: SafeOutcome = { kind: "ok", result: fullLimitResult() };
    const open: SafeOutcome = { kind: "failOpen", label: "x" };
    const closed: SafeOutcome = { kind: "failClosed", label: "y" };
    expect([ok.kind, open.kind, closed.kind]).toEqual([
      "ok",
      "failOpen",
      "failClosed",
    ]);
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

  // TG1: a fail-open throw must not synthesize a fail-closed sentinel —
  // the per-limiter policy is load-bearing. Pins the contract so a future
  // refactor of `safeLimit` cannot conflate the two failure arms.
  it("returns null when a fail-open limiter throws and a fail-closed limiter allows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const open = fakeLimiter("open", async () => {
      throw new Error("ECONNREFUSED");
    });
    const closed = fakeLimiter("closed", async () =>
      fullLimitResult({ success: true }),
    );
    const res = await enforceRateLimits(
      [
        { limiter: open, key: "k-open" },
        { limiter: closed, key: "k-closed" },
      ],
      "msg",
    );
    expect(res).toBeNull();
  });

  it("short-circuits on first deny: later limiters are not invoked, retry-after comes from the first denier", async () => {
    const reset1 = Date.now() + 5_000;
    const aImpl = vi.fn(async () =>
      fullLimitResult({ success: false, reset: reset1 }),
    );
    const bImpl = vi.fn(async () => fullLimitResult({ success: true }));
    const a: RateLimiter = { limit: aImpl, label: "first", failMode: "closed" };
    const b: RateLimiter = {
      limit: bImpl,
      label: "second",
      failMode: "closed",
    };
    const res = await enforceRateLimits(
      [
        { limiter: a, key: "k-a" },
        { limiter: b, key: "k-b" },
      ],
      "msg",
    );
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBe("5");
    expect(aImpl).toHaveBeenCalledTimes(1);
    // T1: short-circuit — second limiter's quota is never decremented when
    // the first limiter has already denied. Prevents per-device storms from
    // draining the per-user budget on /api/realtime-token.
    expect(bImpl).not.toHaveBeenCalled();
  });

  it("returns 503 when first limiter fails closed; later limiters not invoked (no partial drain to log)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const aImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const bImpl = vi.fn(async () =>
      fullLimitResult({ success: false, reset: Date.now() + 60_000 }),
    );
    const a: RateLimiter = { limit: aImpl, label: "first", failMode: "closed" };
    const b: RateLimiter = {
      limit: bImpl,
      label: "second",
      failMode: "closed",
    };
    const res = await enforceRateLimits(
      [
        { limiter: a, key: "k-a" },
        { limiter: b, key: "k-b" },
      ],
      "msg",
    );
    expect(res!.status).toBe(503);
    expect(res!.headers.get("Retry-After")).toBe("30");
    expect(bImpl).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.upstash_unreachable",
      expect.objectContaining({ limiter: "first" }),
    );
    // No earlier success to lament: no partial_drain warn.
    expect(warnSpy).not.toHaveBeenCalledWith(
      "ratelimit.partial_drain",
      expect.anything(),
    );
  });

  it("logs ratelimit.partial_drain when an earlier limiter succeeded but a later limiter fail-closed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const aImpl = vi.fn(async () => fullLimitResult({ success: true }));
    const bImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const a: RateLimiter = {
      limit: aImpl,
      label: "realtime:token",
      failMode: "closed",
    };
    const b: RateLimiter = {
      limit: bImpl,
      label: "realtime:token:user",
      failMode: "closed",
    };
    const res = await enforceRateLimits(
      [
        { limiter: a, key: "k-a" },
        { limiter: b, key: "k-b" },
      ],
      "msg",
    );
    expect(res!.status).toBe(503);
    expect(aImpl).toHaveBeenCalledTimes(1);
    expect(bImpl).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "ratelimit.upstash_unreachable",
      expect.objectContaining({ limiter: "realtime:token:user" }),
    );
    // T1: operators need a single log line linking the device-locked
    // window to the upstream blip — the per-device bucket's token has
    // already been burned; the per-user bucket failed; the device cannot
    // mint until the per-device window rolls over.
    expect(warnSpy).toHaveBeenCalledWith(
      "ratelimit.partial_drain",
      expect.objectContaining({
        succeededLabels: ["realtime:token"],
        failedLabel: "realtime:token:user",
      }),
    );
  });

  it("throws on empty array", async () => {
    await expect(enforceRateLimits([], "msg")).rejects.toThrow(/non-empty/);
  });
});
