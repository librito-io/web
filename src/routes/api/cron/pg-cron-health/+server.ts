import type { RequestHandler } from "./$types";
import { env as privateEnv } from "$env/dynamic/private";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { authorizeCronRequest } from "$lib/server/cron-auth";
import { logger } from "$lib/server/log";
import * as Sentry from "@sentry/sveltekit";

// Daily pg_cron failure surface. Cron handler invariants (CLAUDE.md
// "Cron handlers"):
//   1. GET only — Vercel cron invokes via GET. POST-only handlers
//      silently 405 every fire (see issue #187).
//   2. ?probe=1 short-circuits AFTER auth, BEFORE any side effect.
//   3. CRON_SECRET read via $env/dynamic/private (Sensitive in Vercel).
//
// NOT wrapped in Sentry.withMonitor: free Sentry tier provides one
// cron monitor slot total, allocated to transfer-sweep (higher-impact
// silent failure surface). pg-cron-health failure reverts to the
// pre-#190 unobserved state — acceptable risk at pre-launch scale.
export const GET: RequestHandler = async ({ request, url }) => {
  const authFailure = authorizeCronRequest(request, privateEnv.CRON_SECRET);
  if (authFailure) return authFailure;
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc(
    "pg_cron_failure_summary" as never,
  );

  // Vercel serverless suspends the function on response commit, which can
  // abort the SDK transport's in-flight requests. Sentry's captureException
  // / captureMessage are fire-and-forget — without an explicit flush, the
  // event may never reach the ingest endpoint. Mirrors the pattern in
  // src/lib/server/wait-until.ts:35-41 and the transfer-sweep handler.
  // Issue #358.
  if (error) {
    Sentry.captureException(new Error("pg_cron_health_query_failed"), {
      extra: { dbError: error.message },
    });
    logger().error(
      { event: "pg_cron_health.query_failed", error: error.message },
      "pg_cron_health.query_failed",
    );
    await Sentry.flush(2000);
    return jsonError(500, "server_error", "pg_cron query failed");
  }

  const summary = (data ?? []) as Array<{ jobname: string; failures: number }>;
  const failed = summary.filter((row) => row.failures > 0);

  if (failed.length > 0) {
    Sentry.captureMessage("pg_cron_failures_detected", {
      level: "error",
      tags: { source: "pg_cron_health" },
      extra: { failures: failed, windowDays: 7 },
    });
    logger().error(
      { event: "pg_cron_health.failures", failures: failed },
      "pg_cron_health.failures",
    );
    await Sentry.flush(2000);
  } else {
    logger().info(
      { event: "pg_cron_health.ok", jobsChecked: summary.length },
      "pg_cron_health.ok",
    );
  }

  return jsonSuccess({ failures: failed, jobsChecked: summary.length });
};
