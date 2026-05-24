import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { authorizeCronRequest } from "$lib/server/cron-auth";
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
  const authFailure = authorizeCronRequest(request, privateEnv.CRON_SECRET);
  if (authFailure) return authFailure;

  // ?probe=1 lets the deploy-time smoke check exercise auth + reachability
  // without doing the actual sweep (Storage deletes, DB writes). Gated
  // behind successful auth so an unauthenticated caller can never trigger
  // the short-circuit. Outside the withMonitor scope: emitting check-ins
  // for probe runs would skew the Sentry Crons timeline.
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }

  // Gate withMonitor on production. Preview/dev/local invocations register
  // env-scoped check-in expectations against the cron schedule; once a
  // preview emits a check-in, Sentry expects continued check-ins from that
  // env at every scheduled slot — Vercel cron only fires production, so
  // the preview slot stays empty forever and emits daily "missed check-in"
  // events. See issue #358.
  const isProd = process.env.VERCEL_ENV === "production";
  try {
    const summary = isProd
      ? await Sentry.withMonitor(
          "transfer-sweep",
          () => runTransferSweep(createAdminClient()),
          {
            schedule: { type: "crontab", value: TRANSFER_SWEEP_SCHEDULE },
            // Vercel Hobby cron precision is ±59 min — `0 3 * * *` may fire
            // anywhere in 03:00–03:59 UTC. Margin must cover the full window
            // or Sentry emits a false-positive "missed check-in" before
            // Vercel invokes the handler (issue #385, LIBRITO-WEB-B).
            // Drop back to 5 when upgrading to Vercel Pro (per-minute jitter).
            checkinMargin: 60, // minutes — alert if check-in late by >60 min
            maxRuntime: 10, // minutes — alert if run takes >10 min
            failureIssueThreshold: 1, // first failure creates an issue
            recoveryThreshold: 1, // one success after failure resolves it
          },
        )
      : await runTransferSweep(createAdminClient());
    // withMonitor's close check-in is dispatched via Sentry's async
    // transport (fire-and-forget captureCheckIn in @sentry/core). Vercel
    // serverless suspends the function on response commit, which can abort
    // in-flight transport requests — Sentry never receives the "ok" and
    // emits a "timeout check-in" event after maxRuntime. Flush before
    // return so the close lands. See src/lib/server/wait-until.ts:35-41
    // for the codebase's existing documentation of this bug class.
    await Sentry.flush(2000);
    return jsonSuccess({ sweep: summary });
  } catch (err) {
    // withMonitor already emitted an error check-in to Sentry. The
    // sentryHandle() wrapper in hooks.server.ts will also captureException
    // via handleErrorWithSentry — acceptable duplication; both surfaces
    // are useful (Crons UI shows failure pattern, Issues UI shows stack).
    await Sentry.flush(2000);
    return jsonError(
      500,
      "server_error",
      err instanceof Error ? err.message : "transfer_sweep_failed",
    );
  }
};
