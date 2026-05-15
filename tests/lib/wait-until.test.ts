import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInBackground } from "../../src/lib/server/wait-until";
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";

describe("runInBackground", () => {
  let logWrites: Record<string, unknown>[];

  beforeEach(() => {
    logWrites = [];
    __setTestDestination((line) => logWrites.push(JSON.parse(line)));
  });

  afterEach(() => __resetTestDestination());

  it("uses event.platform.context.waitUntil when available", () => {
    const waitUntil = vi.fn();
    runInBackground(
      { platform: { context: { waitUntil } } } as never,
      async () => {},
    );
    expect(waitUntil).toHaveBeenCalled();
  });

  it("falls back to setImmediate-style scheduling when platform missing", async () => {
    const fn = vi.fn(async () => {});
    runInBackground({} as never, fn);
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).toHaveBeenCalled();
  });

  it("logs unhandled rejection from background work", async () => {
    runInBackground({} as never, async () => {
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(logWrites).toContainEqual(
      expect.objectContaining({
        event: "wait_until_failed",
        error: "boom",
      }),
    );
  });
});
