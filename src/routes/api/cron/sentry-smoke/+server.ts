import type { RequestHandler } from "./$types";
import { env as privateEnv } from "$env/dynamic/private";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { constantTimeEqualString } from "$lib/server/cron-auth";
import { runInBackground } from "$lib/server/wait-until";

// Operator health probe for the Sentry pipeline. POST-only (avoids
// accidental browser/crawler hits on GET). Three-rule pattern matching
// cron handlers (see CLAUDE.md "Cron handlers"):
//   1. 500 if CRON_SECRET unset (config drift)
//   2. 401 if bearer mismatch
//   3. ?probe=1 short-circuits after auth (CI reachability check)
// Past those gates, the non-probe path schedules a runInBackground throw
// that propagates into Sentry.captureException via wait-until.ts.
export const POST: RequestHandler = async (event) => {
  const { request, url } = event;
  const cronSecret = privateEnv.CRON_SECRET;
  if (!cronSecret) {
    return jsonError(500, "server_misconfigured", "CRON_SECRET unset");
  }
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (!constantTimeEqualString(auth, expected)) {
    return jsonError(401, "unauthorized", "Sentry smoke secret mismatch");
  }
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }

  // Unique id per fire so the operator can correlate the curl with the
  // event that lands in Sentry. ~3.4M states is plenty for a smoke
  // endpoint that fires at most a handful of times per install.
  const id = crypto.randomUUID().slice(0, 8);
  runInBackground(async () => {
    throw new Error(`sentry-smoke-test-${id}`);
  });
  return jsonSuccess({ scheduled: true, id }, 202);
};
