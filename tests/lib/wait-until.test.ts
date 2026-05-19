import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";

const captureException = vi.fn();
const flush = vi.fn(async () => true);
vi.mock("@sentry/sveltekit", () => ({
  captureException,
  flush,
}));

const waitUntilMock = vi.fn();
vi.mock("@vercel/functions", () => ({
  waitUntil: waitUntilMock,
}));

// Import AFTER mocks so the SDK + waitUntil are the mocked ones.
const { runInBackground } = await import("../../src/lib/server/wait-until");

describe("runInBackground", () => {
  let logWrites: Record<string, unknown>[];

  beforeEach(() => {
    logWrites = [];
    __setTestDestination((line) => logWrites.push(JSON.parse(line)));
    captureException.mockClear();
    flush.mockClear();
    waitUntilMock.mockClear();
  });

  afterEach(() => __resetTestDestination());

  it("registers the wrapped promise with @vercel/functions waitUntil", () => {
    runInBackground(async () => {});
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    const arg = waitUntilMock.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Promise);
  });

  it("starts the work synchronously (microtask) — does not wait for waitUntil host", async () => {
    const fn = vi.fn(async () => {});
    runInBackground(fn);
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).toHaveBeenCalled();
  });

  it("logs unhandled rejection from background work", async () => {
    runInBackground(async () => {
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
    runInBackground(async () => {
      throw err;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(captureException).toHaveBeenCalledWith(err, {
      tags: { wait_until: true },
    });
  });

  it("both logs and captures on the same throw (additive paths)", async () => {
    runInBackground(async () => {
      throw new Error("dual");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(logWrites).toContainEqual(
      expect.objectContaining({ event: "wait_until_failed", error: "dual" }),
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("registers the post-catch wrapped promise so Sentry flush is awaited inside the waitUntil window", async () => {
    let resolveFlush!: () => void;
    flush.mockImplementationOnce(
      () =>
        new Promise<boolean>((r) => {
          resolveFlush = () => r(true);
        }),
    );
    runInBackground(async () => {
      throw new Error("flush-window");
    });
    // The promise registered with waitUntil is the catch-wrapped one — it
    // resolves only after Sentry.flush settles, ensuring Vercel keeps the
    // function alive long enough for the async transport to complete.
    const registered = waitUntilMock.mock.calls[0][0] as Promise<unknown>;
    let settled = false;
    void registered.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    resolveFlush();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
  });
});
