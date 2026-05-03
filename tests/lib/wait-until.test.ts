import { describe, it, expect, vi } from "vitest";
import { runInBackground } from "../../src/lib/server/wait-until";

describe("runInBackground", () => {
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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runInBackground({} as never, async () => {
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/wait-until-failed/),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
