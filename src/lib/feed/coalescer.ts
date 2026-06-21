export interface Coalescer {
  /** Request a fire on the trailing edge (bounded by the max-wait ceiling). */
  schedule(): void;
  /** Clear any pending fire and reset the window. */
  cancel(): void;
}

/**
 * Trailing-edge debounce with a hard max-wait ceiling. `schedule()` coalesces
 * bursts into one `fire()` after `delayMs` of quiet; if events keep arriving
 * inside the debounce window, `fire()` still runs at most `maxWaitMs` after the
 * first un-fired `schedule()` so a continuous stream (active sync) refetches
 * periodically instead of starving.
 */
export function createCoalescer(opts: {
  delayMs: number;
  maxWaitMs: number;
  fire: () => void;
}): Coalescer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let firstScheduledAt: number | null = null;

  function run(): void {
    handle = null;
    firstScheduledAt = null;
    opts.fire();
  }

  return {
    schedule(): void {
      const now = Date.now();
      if (firstScheduledAt === null) firstScheduledAt = now;
      if (handle !== null) clearTimeout(handle);
      const sinceFirst = now - firstScheduledAt;
      const remainingMax = opts.maxWaitMs - sinceFirst;
      const wait = Math.max(0, Math.min(opts.delayMs, remainingMax));
      handle = setTimeout(run, wait);
    },
    cancel(): void {
      if (handle !== null) clearTimeout(handle);
      handle = null;
      firstScheduledAt = null;
    },
  };
}
