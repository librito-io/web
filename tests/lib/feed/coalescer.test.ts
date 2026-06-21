import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescer } from "$lib/feed/coalescer";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createCoalescer", () => {
  it("fires once after delayMs of quiet following a single schedule", () => {
    const fire = vi.fn();
    const c = createCoalescer({ delayMs: 500, maxWaitMs: 2000, fire });
    c.schedule();
    vi.advanceTimersByTime(499);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into a single trailing-edge fire", () => {
    const fire = vi.fn();
    const c = createCoalescer({ delayMs: 500, maxWaitMs: 2000, fire });
    c.schedule();
    vi.advanceTimersByTime(200);
    c.schedule(); // resets the trailing timer
    vi.advanceTimersByTime(200);
    c.schedule();
    vi.advanceTimersByTime(499);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("honors the max-wait ceiling under a continuous sub-window stream (starvation case)", () => {
    const fire = vi.fn();
    const c = createCoalescer({ delayMs: 500, maxWaitMs: 2000, fire });
    // Schedule every 100ms (always inside the 500ms debounce window) for 2s.
    // Without the ceiling this would never fire; with it, it fires by maxWait.
    for (let t = 0; t < 2000; t += 100) {
      c.schedule();
      vi.advanceTimersByTime(100);
    }
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents a pending fire", () => {
    const fire = vi.fn();
    const c = createCoalescer({ delayMs: 500, maxWaitMs: 2000, fire });
    c.schedule();
    vi.advanceTimersByTime(200);
    c.cancel();
    vi.advanceTimersByTime(1000);
    expect(fire).not.toHaveBeenCalled();
  });
});
