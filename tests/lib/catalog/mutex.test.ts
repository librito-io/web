import { describe, it, expect, vi } from "vitest";
import {
  createUpstashMutex,
  createTestMutex,
  noopMutex,
} from "../../../src/lib/server/catalog/mutex";

describe("createTestMutex", () => {
  it("acquire returns true once for a fresh key", async () => {
    const m = createTestMutex();
    expect(await m.acquire("k1")).toBe(true);
  });

  it("acquire returns false on a held key", async () => {
    const m = createTestMutex();
    await m.acquire("k1");
    expect(await m.acquire("k1")).toBe(false);
  });

  it("acquire returns true again after release", async () => {
    const m = createTestMutex();
    await m.acquire("k1");
    await m.release("k1");
    expect(await m.acquire("k1")).toBe(true);
  });

  it("different keys are independent", async () => {
    const m = createTestMutex();
    expect(await m.acquire("a")).toBe(true);
    expect(await m.acquire("b")).toBe(true);
    expect(await m.acquire("a")).toBe(false);
    expect(await m.acquire("b")).toBe(false);
  });
});

describe("noopMutex", () => {
  it("always wins", async () => {
    expect(await noopMutex.acquire("anything")).toBe(true);
    expect(await noopMutex.acquire("anything")).toBe(true);
  });
});

describe("createUpstashMutex", () => {
  // Cast to the structural shape `createUpstashMutex` expects. The
  // upstream `Redis['set']` signature is generic over response shape;
  // these tests model the documented behavior (returns "OK" | null on
  // an `nx` set). Avoid full Redis-typing here — the test surface only
  // exercises the two methods.
  type MutexRedis = Parameters<typeof createUpstashMutex>[0];

  function makeRedis(setReturn: () => Promise<unknown>): MutexRedis & {
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  } {
    return {
      set: vi.fn(setReturn),
      del: vi.fn(async () => 1),
    } as unknown as MutexRedis & {
      set: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };
  }

  it("returns true when SETNX returns OK", async () => {
    const redis = makeRedis(async () => "OK");
    const m = createUpstashMutex(redis);
    expect(await m.acquire("catalog:lock:isbn:9780743273565")).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      "catalog:lock:isbn:9780743273565",
      "1",
      { nx: true, ex: 30 },
    );
  });

  it("returns false when SETNX returns null (key already held)", async () => {
    const redis = makeRedis(async () => null);
    const m = createUpstashMutex(redis);
    expect(await m.acquire("k")).toBe(false);
  });

  it("returns false on unexpected response shapes", async () => {
    const redis = makeRedis(async () => 1);
    const m = createUpstashMutex(redis);
    expect(await m.acquire("k")).toBe(false);
  });

  it("fail-OPEN: acquire returns true when redis throws", async () => {
    const redis = makeRedis(async () => {
      throw new Error("upstash unreachable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createUpstashMutex(redis);
    expect(await m.acquire("k")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "catalog_mutex_acquire_failed",
      expect.objectContaining({ key: "k" }),
    );
    warn.mockRestore();
  });

  it("release calls redis.del", async () => {
    const redis = makeRedis(async () => "OK");
    const m = createUpstashMutex(redis);
    await m.release("k");
    expect(redis.del).toHaveBeenCalledWith("k");
  });

  it("release does not propagate redis.del errors", async () => {
    const redis = makeRedis(async () => "OK");
    redis.del.mockImplementationOnce(async () => {
      throw new Error("upstash blip");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createUpstashMutex(redis);
    await expect(m.release("k")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "catalog_mutex_release_failed",
      expect.objectContaining({ key: "k" }),
    );
    warn.mockRestore();
  });
});
