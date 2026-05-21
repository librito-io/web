import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { constantTimeEqualString } from "$lib/server/cron-auth";
// `$env/dynamic/private` (runtime read) is required because CRON_SECRET is
// marked Sensitive in Vercel. Sensitive vars are redacted by `vercel pull`,
// so `$env/static/private` (build-inlined) would bake an empty string into
// the deployed bundle and every cron fire would 401. See PR #194 thread.
import { env as privateEnv } from "$env/dynamic/private";
import { runTransferSweep } from "$lib/server/transfer/sweep";
import * as Sentry from "@sentry/sveltekit";

// Mirror of vercel.ts crons[] entry for /api/cron/transfer-sweep. Sentry's
// monitor config needs the schedule at the SDK call site to compute
// expected check-in times; Vercel reads vercel.ts at a different layer.
// Drift surfaces fast — a real off-schedule fire produces a "missed
// check-in" alert in the Sentry Crons UI within minutes.
const TRANSFER_SWEEP_SCHEDULE = "0 3 * * *";

// Vercel cron invokes scheduled paths via GET. A POST-only handler returns
// 405 every fire and never executes Pass A/B. See issue #187.
export const GET: RequestHandler = async ({ request, url }) => {
  const cronSecret = privateEnv.CRON_SECRET;
  if (!cronSecret) {
    return jsonError(500, "server_misconfigured", "CRON_SECRET unset");
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!constantTimeEqualString(auth, `Bearer ${cronSecret}`)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }

  // ?probe=1 lets the deploy-time smoke check exercise auth + reachability
  // without doing the actual sweep (Storage deletes, DB writes). Gated
  // behind successful auth so an unauthenticated caller can never trigger
  // the short-circuit. Outside the withMonitor scope: emitting check-ins
  // for probe runs would skew the Sentry Crons timeline.
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }

  try {
    const summary = await Sentry.withMonitor(
      "transfer-sweep",
      () => runTransferSweep(createAdminClient()),
      {
        schedule: { type: "crontab", value: TRANSFER_SWEEP_SCHEDULE },
        checkinMargin: 5, // minutes — alert if check-in late by >5 min
        maxRuntime: 10, // minutes — alert if run takes >10 min
        failureIssueThreshold: 1, // first failure creates an issue
        recoveryThreshold: 1, // one success after failure resolves it
      },
    );
    return jsonSuccess({ sweep: summary });
  } catch (err) {
    // withMonitor already emitted an error check-in to Sentry. The
    // sentryHandle() wrapper in hooks.server.ts will also captureException
    // via handleErrorWithSentry — acceptable duplication; both surfaces
    // are useful (Crons UI shows failure pattern, Issues UI shows stack).
    return jsonError(
      500,
      "server_error",
      err instanceof Error ? err.message : "transfer_sweep_failed",
    );
  }
};
