import type { RequestHandler } from "./$types";
import type { Json } from "$lib/types/database";
import { Client as QStashClient } from "@upstash/qstash";
import * as Sentry from "@sentry/sveltekit";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { authorizeCronRequest } from "$lib/server/cron-auth";
import { logger } from "$lib/server/log";
// CRON_SECRET + QSTASH_TOKEN both Sensitive in Vercel; static-imported
// sensitive vars bake empty into prebuilt deploys and the cron silently
// 401s every fire. Read via dynamic/private at runtime.
import { env as privateEnv } from "$env/dynamic/private";

// Cap per-run. QStash DLQ list returns up to ~1000 by default; cap is
// fan-out hygiene against an unbounded backlog after an extended
// upstream outage.
const MAX_PER_RUN = 100;

interface DlqMessage {
  messageId: string;
  body: string;
  createdAt: number;
  errorDetails?: string | null;
}

// Cron handler invariants (CLAUDE.md "Cron handlers"):
//   1. GET only (Vercel cron invokes via GET)
//   2. ?probe=1 short-circuit AFTER auth, BEFORE side effects
//   3. CRON_SECRET via $env/dynamic/private
//
// Self-hoster gate: implicit on !QSTASH_TOKEN. Matches the catalog-replay
// CATALOG_REPLAY_ENABLED skip pattern. Gate on QSTASH_TOKEN only (not
// CONSUMER_URL) — if the token is set but the URL isn't, the QStash project
// still exists and may carry DLQ entries from prior runs.
//
// Not wrapped in Sentry.withMonitor: free-tier provides one monitor slot,
// allocated to transfer-sweep. captureMessage per archived item still
// surfaces DLQ activity.
export const GET: RequestHandler = async ({ request, url }) => {
  const authFailure = authorizeCronRequest(request, privateEnv.CRON_SECRET);
  if (authFailure) return authFailure;
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }
  if (!privateEnv.QSTASH_TOKEN) {
    return jsonSuccess({ skipped: true });
  }

  const start = Date.now();
  const qstash = new QStashClient({ token: privateEnv.QSTASH_TOKEN });
  const admin = createAdminClient();

  let messages: DlqMessage[];
  try {
    const res = await qstash.dlq.listMessages({ count: MAX_PER_RUN });
    messages = (res?.messages ?? []) as DlqMessage[];
  } catch (err) {
    logger().error(
      {
        event: "cron.catalog_dlq_drain.list_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "cron.catalog_dlq_drain.list_failed",
    );
    Sentry.captureException(err, {
      tags: { cron: "catalog-dlq-drain", phase: "list" },
    });
    await Sentry.flush(2000);
    return jsonError(500, "dlq_list_failed", "see logs");
  }

  let archived = 0;
  for (const msg of messages) {
    try {
      // ON CONFLICT DO NOTHING semantics: a prior run may have inserted this
      // row but then the QStash delete failed. Re-inserting hits the UNIQUE
      // constraint on message_id (Postgres 23505). Treat that as "already
      // archived; just delete from QStash now" and continue.
      let payload: Json;
      try {
        payload = JSON.parse(msg.body);
      } catch {
        payload = { raw: msg.body };
      }
      // Safe coercion: new Date(undefined) / new Date(NaN) throws RangeError.
      // Fall back to now so a malformed createdAt doesn't abort the batch.
      const createdAt = Number.isFinite(msg.createdAt)
        ? new Date(msg.createdAt)
        : new Date();
      const { error: insErr } = await admin.from("catalog_dlq_archive").insert({
        message_id: msg.messageId,
        payload,
        first_failed_at: createdAt.toISOString(),
        fail_reason: msg.errorDetails ?? null,
      });
      if (insErr && (insErr as { code?: string }).code !== "23505") {
        logger().warn(
          {
            event: "cron.catalog_dlq_drain.insert_failed",
            messageId: msg.messageId,
            error: insErr.message,
          },
          "cron.catalog_dlq_drain.insert_failed",
        );
        Sentry.captureException(insErr, {
          tags: { cron: "catalog-dlq-drain", phase: "insert" },
        });
        continue;
      }
      try {
        await qstash.dlq.delete(msg.messageId);
      } catch (err) {
        // Delete failure leaves the message in DLQ for the next run; ON
        // CONFLICT keeps the archive row idempotent. Sentry-capture but do
        // not bail the batch.
        logger().warn(
          {
            event: "cron.catalog_dlq_drain.qstash_delete_failed",
            messageId: msg.messageId,
            error: err instanceof Error ? err.message : String(err),
          },
          "cron.catalog_dlq_drain.qstash_delete_failed",
        );
        Sentry.captureException(err, {
          tags: { cron: "catalog-dlq-drain", phase: "delete" },
        });
        continue;
      }
      Sentry.captureMessage(`catalog DLQ entry archived: ${msg.messageId}`, {
        level: "warning",
        tags: { cron: "catalog-dlq-drain", messageId: msg.messageId },
        extra: {
          fail_reason: msg.errorDetails ?? null,
          // userId stripped from payload before passing to Sentry — Supabase
          // auth UUID, no diagnostic value at the operator triage layer.
          item: (payload as { item?: unknown })?.item ?? null,
        },
      });
      archived++;
    } catch (err) {
      logger().warn(
        {
          event: "cron.catalog_dlq_drain.message_failed",
          messageId: msg.messageId,
          error: err instanceof Error ? err.message : String(err),
        },
        "cron.catalog_dlq_drain.message_failed",
      );
      Sentry.captureException(err, {
        tags: { cron: "catalog-dlq-drain", phase: "iteration" },
      });
      continue;
    }
  }

  const durationMs = Date.now() - start;
  logger().info(
    {
      event: "cron.catalog_dlq_drain",
      candidates: messages.length,
      archived,
      durationMs,
    },
    "cron.catalog_dlq_drain",
  );
  await Sentry.flush(2000);
  return jsonSuccess({ candidates: messages.length, archived, durationMs });
};
