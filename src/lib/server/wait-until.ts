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
  const promise = work().catch((err) => {
    logger().error(
      {
        event: "wait_until_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "wait_until_failed",
    );
    Sentry.captureException(err, { tags: { wait_until: true } });
  });
  const wu = (event as WaitUntilHost).platform?.context?.waitUntil;
  if (typeof wu === "function") {
    wu(promise);
    return;
  }
  // Local dev / non-Vercel runtime: ignore — promise is already running and
  // its rejection is captured by the .catch above.
}
