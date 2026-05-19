import { waitUntil } from "@vercel/functions";
import * as Sentry from "@sentry/sveltekit";
import { logger } from "$lib/server/log";

/**
 * Register `work` to run on the Vercel function instance with Vercel's
 * lifetime guarantee, so the runtime keeps the function alive until the
 * promise settles instead of suspending after the response is sent.
 *
 * Uses `@vercel/functions` `waitUntil()` rather than
 * `event.platform.context.waitUntil` because `@sveltejs/adapter-vercel`'s
 * **serverless** runtime does NOT populate `platform.context` — only the
 * edge runtime does (compare `node_modules/@sveltejs/adapter-vercel/files/
 * serverless.js` vs `edge.js`). svelte.config.js pins `nodejs24.x`
 * (Fluid Compute / serverless), so the prior `platform?.context?.waitUntil`
 * lookup was always undefined in production, silently dropping every
 * scheduled background task (issue #226).
 *
 * `@vercel/functions` waitUntil reads from `globalThis[Symbol.for(
 * "@vercel/request-context")]` which Vercel's Node.js runtime populates
 * per-invocation. Off-Vercel (local dev, vitest) the symbol is absent and
 * waitUntil is a no-op — the promise still runs to completion via the
 * normal Node.js microtask queue.
 */
export function runInBackground(work: () => Promise<unknown>): void {
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
  waitUntil(promise);
}
