import type { RequestEvent } from "@sveltejs/kit";
import * as Sentry from "@sentry/sveltekit";
import { logger } from "$lib/server/log";

interface WaitUntilHost {
  platform?: { context?: { waitUntil?: (p: Promise<unknown>) => void } };
}

export function runInBackground(
  event: RequestEvent | WaitUntilHost,
  work: () => Promise<unknown>,
): void {
  const promise = work().catch(async (err) => {
    logger().error(
      {
        event: "wait_until_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "wait_until_failed",
    );
    Sentry.captureException(err, { tags: { wait_until: true } });
    // Vercel suspends the function once waitUntil's promise resolves.
    // Without an explicit flush, Sentry's async transport may not finish
    // transmitting before suspension and the event is lost. 2s is enough
    // headroom for the network round-trip to Sentry's ingest endpoint.
    // No-op when SDK is not initialized (self-hoster path).
    await Sentry.flush(2000);
  });
  const wu = (event as WaitUntilHost).platform?.context?.waitUntil;
  if (typeof wu === "function") {
    wu(promise);
    return;
  }
  // Local dev / non-Vercel runtime: ignore — promise is already running and
  // its rejection is captured by the .catch above.
}
