import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { authorizeCronRequest } from "$lib/server/cron-auth";
import { logger } from "$lib/server/log";
import * as Sentry from "@sentry/sveltekit";
// CRON_SECRET + CATALOG_FILL_RATE_ENABLED are Sensitive in Vercel; static
// imports bake empty values into prebuilt deploys (vercel pull redacts
// sensitive vars). Read at runtime via dynamic/private instead.
import { env as privateEnv } from "$env/dynamic/private";

// Weekly fill-rate snapshot. Cron handler invariants per CLAUDE.md
// "Cron handlers": GET only, ?probe=1 after auth, CRON_SECRET via
// $env/dynamic/private.
//
// Not wrapped in Sentry.withMonitor: Free-tier slot is allocated to
// transfer-sweep. Sentry.captureMessage carries the below-threshold
// alert without consuming a monitor slot.
const FILL_RATE_ALERT_THRESHOLD = 0.8;

export const GET: RequestHandler = async ({ request, url }) => {
  const authFailure = authorizeCronRequest(request, privateEnv.CRON_SECRET);
  if (authFailure) return authFailure;
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }
  if (privateEnv.CATALOG_FILL_RATE_ENABLED !== "true") {
    return jsonSuccess({ skipped: true });
  }

  const admin = createAdminClient();

  // RPC returns `{ ... }[]` (set-returning fn) — read the first row.
  const { data: rows, error } = await admin.rpc("compute_catalog_fill_rate");
  if (error) {
    logger().error(
      { event: "cron.catalog_fill_rate.select_failed", error: error.message },
      "cron.catalog_fill_rate.select_failed",
    );
    return jsonError(500, "select_failed", error.message);
  }
  const data = rows?.[0];
  if (!data) {
    logger().error(
      { event: "cron.catalog_fill_rate.empty_aggregate" },
      "cron.catalog_fill_rate.empty_aggregate",
    );
    return jsonError(
      500,
      "empty_aggregate",
      "compute_catalog_fill_rate returned no rows",
    );
  }

  const snapshot = {
    total_rows: data.total_rows,
    missing_cover: data.missing_cover,
    missing_description: data.missing_description,
    missing_publisher: data.missing_publisher,
    missing_published_date: data.missing_published_date,
    missing_subjects: data.missing_subjects,
    missing_page_count: data.missing_page_count,
    desc_from_openlibrary: data.desc_from_openlibrary,
    desc_from_google_books: data.desc_from_google_books,
    desc_from_itunes: data.desc_from_itunes,
    desc_from_manual: data.desc_from_manual,
  };

  const { error: insertErr } = await admin
    .from("catalog_fill_rate_history")
    .insert(snapshot);
  if (insertErr) {
    logger().error(
      {
        event: "cron.catalog_fill_rate.insert_failed",
        error: insertErr.message,
      },
      "cron.catalog_fill_rate.insert_failed",
    );
    return jsonError(500, "insert_failed", insertErr.message);
  }

  // Threshold alerting via captureMessage — Sentry SDK 10 has no metrics
  // API. Total guard prevents a div-by-zero before the catalog has any
  // rows (first snapshot post-truncate).
  const total = snapshot.total_rows;
  if (total > 0) {
    const coverFillRate = (total - snapshot.missing_cover) / total;
    const descriptionFillRate = (total - snapshot.missing_description) / total;
    if (
      coverFillRate < FILL_RATE_ALERT_THRESHOLD ||
      descriptionFillRate < FILL_RATE_ALERT_THRESHOLD
    ) {
      Sentry.captureMessage("catalog_fill_rate_below_threshold", {
        level: "warning",
        tags: { source: "catalog_fill_rate" },
        extra: {
          coverFillRate,
          descriptionFillRate,
          threshold: FILL_RATE_ALERT_THRESHOLD,
          ...snapshot,
        },
      });
      // Vercel suspends the function on response commit; without flush,
      // the in-flight Sentry transport may abort and the alert is lost.
      // Mirrors the pg-cron-health + transfer-sweep flush pattern.
      await Sentry.flush(2000);
    }
  }

  logger().info(
    { event: "cron.catalog_fill_rate", ...snapshot },
    "cron.catalog_fill_rate",
  );

  return jsonSuccess(snapshot);
};
