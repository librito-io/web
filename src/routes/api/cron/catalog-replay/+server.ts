import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { authorizeCronRequest } from "$lib/server/cron-auth";
import {
  scheduleCatalogResolveIfAllowed,
  type CatalogResolveWork,
} from "$lib/server/catalog/scheduling";
import { SERVICE_USER_ID } from "$lib/server/catalog/constants";
import { TRACKED_FIELDS, type TrackedField } from "$lib/server/catalog/types";
import { logger } from "$lib/server/log";
// CRON_SECRET + CATALOG_REPLAY_ENABLED are Sensitive in Vercel; static
// imports bake empty values into prebuilt deploys (vercel pull redacts
// sensitive vars). Read at runtime via dynamic/private instead.
import { env as privateEnv } from "$env/dynamic/private";

// Cap per-run batch. Per-source limiters (OL 80/5min, GB 800/day, iTunes
// generous) absorb the upstream calls; the cap is fan-out hygiene, not
// upstream protection. Tunable up if a future operator runbook calls for
// catching up a larger backlog.
const MAX_PER_RUN = 100;

const TRACKED_FIELD_SET = new Set<string>(TRACKED_FIELDS);

function toTrackedFields(raw: string[] | null | undefined): TrackedField[] {
  if (!raw) return [];
  return raw.filter((f): f is TrackedField => TRACKED_FIELD_SET.has(f));
}

// Nightly cron handler. Cron handler invariants (CLAUDE.md "Cron
// handlers"):
//   1. GET only — Vercel cron invokes via GET. POST-only handlers
//      silently 405 every fire (issue #187).
//   2. ?probe=1 short-circuits AFTER auth, BEFORE any side effect.
//   3. CRON_SECRET read via $env/dynamic/private (Sensitive in Vercel).
//
// Not wrapped in Sentry.withMonitor: Sentry free-tier provides one
// cron monitor slot total, allocated to transfer-sweep (higher-impact
// silent-failure surface). Replay miss is recoverable on the next fire.
export const GET: RequestHandler = async ({ request, url }) => {
  const authFailure = authorizeCronRequest(request, privateEnv.CRON_SECRET);
  if (authFailure) return authFailure;
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }
  if (privateEnv.CATALOG_REPLAY_ENABLED !== "true") {
    return jsonSuccess({ skipped: true });
  }

  const start = Date.now();
  const admin = createAdminClient();

  const { data: rows, error } = await admin.rpc("select_replay_candidates", {
    p_limit: MAX_PER_RUN,
  });
  if (error) {
    logger().error(
      { event: "cron.catalog_replay.select_failed", error: error.message },
      "cron.catalog_replay.select_failed",
    );
    return jsonError(500, "select_failed", error.message);
  }

  if (!rows || rows.length === 0) {
    const durationMs = Date.now() - start;
    logger().info(
      { event: "cron.catalog_replay", replayed: 0, durationMs },
      "cron.catalog_replay",
    );
    return jsonSuccess({ replayed: 0, durationMs });
  }

  const work: CatalogResolveWork[] = rows.flatMap((r): CatalogResolveWork[] => {
    const fields = toTrackedFields(r.replay_fields);
    if (fields.length === 0) return [];
    if (r.isbn) {
      const ctx =
        r.title && r.author ? { title: r.title, author: r.author } : undefined;
      return [{ kind: "isbn", isbn: r.isbn, ctx, fields }];
    }
    if (r.title && r.author) {
      // Thread the row's stored key so a drifted row re-resolves in place
      // rather than forking (issue #489 Fix A) — same fix as the admin
      // requeue caller. `select_replay_candidates` returns it on every row.
      return [
        {
          kind: "ta",
          title: r.title,
          author: r.author,
          fields,
          ...(r.normalized_title_author
            ? { normalizedTitleAuthor: r.normalized_title_author }
            : {}),
        },
      ];
    }
    return [];
  });

  await scheduleCatalogResolveIfAllowed(SERVICE_USER_ID, work, {
    bypassUserLimit: true,
  });

  const durationMs = Date.now() - start;
  logger().info(
    {
      event: "cron.catalog_replay",
      candidates: rows.length,
      scheduled: work.length,
      durationMs,
    },
    "cron.catalog_replay",
  );

  return jsonSuccess({
    candidates: rows.length,
    scheduled: work.length,
    durationMs,
  });
};
