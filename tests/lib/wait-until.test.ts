import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";

const captureException = vi.fn();
const flush = vi.fn(async () => true);
vi.mock("@sentry/sveltekit", () => ({
  captureException,
  flush,
}));

// Import AFTER mock so the SDK's captureException is the mocked one.
const { runInBackground } = await import("../../src/lib/server/wait-until");

describe("runInBackground", () => {
  let logWrites: Record<string, unknown>[];

  beforeEach(() => {
    logWrites = [];
    __setTestDestination((line) => logWrites.push(JSON.parse(line)));
    captureException.mockClear();
    flush.mockClear();
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

  it("captures unhandled rejection to Sentry with wait_until tag", async () => {
    const err = new Error("captured");
    runInBackground({} as never, async () => {
      throw err;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(captureException).toHaveBeenCalledWith(err, {
      tags: { wait_until: true },
    });
  });

  it("both logs and captures on the same throw (additive paths)", async () => {
    runInBackground({} as never, async () => {
      throw new Error("dual");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(logWrites).toContainEqual(
      expect.objectContaining({ event: "wait_until_failed", error: "dual" }),
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
