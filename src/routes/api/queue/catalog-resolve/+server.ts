import type { RequestHandler } from "./$types";
import { Receiver } from "@upstash/qstash";
import * as Sentry from "@sentry/sveltekit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { createAdminClient } from "$lib/server/supabase";
import {
  catalogRateLimiters,
  dispatchResolve,
  parseWorkPayload,
} from "$lib/server/catalog/dispatch";
import { getCatalogMutex } from "$lib/server/catalog/mutex";
import { logger } from "$lib/server/log";
// All QSTASH_* vars are Sensitive in Vercel; static imports redact to empty
// on prebuilt deploys. Read at runtime via $env/dynamic/private. See CLAUDE.md
// "Vercel Sensitive env vars require $env/dynamic/private".
import { env as privateEnv } from "$env/dynamic/private";

export const POST: RequestHandler = async ({ request }) => {
  // Lazy guard: matches the established CRON_SECRET pattern at
  // src/routes/api/cron/catalog-replay/+server.ts:41. A missing signing key
  // or consumer URL surfaces as a 500 at handler entry rather than a
  // module-init throw or silent 401-loop.
  if (
    !privateEnv.QSTASH_CURRENT_SIGNING_KEY ||
    !privateEnv.QSTASH_NEXT_SIGNING_KEY ||
    !privateEnv.QSTASH_CONSUMER_URL
  ) {
    return jsonError(
      500,
      "server_misconfigured",
      "qstash signing keys or consumer URL unset",
    );
  }
  const receiver = new Receiver({
    currentSigningKey: privateEnv.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: privateEnv.QSTASH_NEXT_SIGNING_KEY,
  });

  // Headers.get is case-insensitive; QStash sends `Upstash-Signature`.
  const signature = request.headers.get("upstash-signature");
  const body = await request.text();
  // Bind to the publisher-signed URL (QSTASH_CONSUMER_URL) rather than the
  // Vercel-reconstructed request.url. Custom domain / preview alias / proxy
  // rewrite / trailing-slash normalization can make request.url drift from
  // the URL the publisher signed against, which would reject every fire.
  // Consumer-side QSTASH_CONSUMER_URL must match publisher-side exactly.
  // Receiver.verify rejects on bad signature in some SDK versions, resolves
  // to false in others. .catch(() => false) handles both — do not "simplify".
  const valid = await receiver
    .verify({
      signature: signature ?? "",
      body,
      url: privateEnv.QSTASH_CONSUMER_URL,
    })
    .catch(() => false);
  if (!valid) return jsonError(401, "invalid_signature", "signature rejected");

  const parsed = parseWorkPayload(body);
  if (!parsed.ok) return jsonError(400, "bad_payload", parsed.error);

  const { userId, item } = parsed.value;
  const admin = createAdminClient();
  const mutex = await getCatalogMutex();
  const deps = {
    rateLimiters: catalogRateLimiters,
    mutex,
    googleBooksApiKey: privateEnv.GOOGLE_BOOKS_API_KEY,
  };

  const startedAt = Date.now();
  const key =
    item.kind === "isbn" ? item.isbn : `${item.title} | ${item.author}`;
  const span = Sentry.startInactiveSpan({
    name: "catalog.queue.resolve",
    op: "queue.process",
  });
  try {
    await dispatchResolve(admin, deps, userId, item);
    span.setStatus({ code: 1 });
    logger().info(
      {
        event: "catalog.queue.resolved",
        userId,
        kind: item.kind,
        key,
        durationMs: Date.now() - startedAt,
        ok: true,
      },
      "catalog.queue.resolved",
    );
    return jsonSuccess({ resolved: true });
  } catch (err) {
    span.setStatus({ code: 2 });
    Sentry.captureException(err, { tags: { queue: "catalog-resolve" } });
    logger().error(
      {
        event: "catalog.queue.resolve_failed",
        userId,
        kind: item.kind,
        key,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      "catalog.queue.resolve_failed",
    );
    // 5xx tells QStash to retry. 4xx would route to DLQ permanently — used
    // only for malformed-payload + signature failures above. Body message is
    // a static string; QStash persists the response body in delivery logs +
    // DLQ inspection UI, so leaking raw Supabase/Sentry exception text would
    // land internal table/column/hostname fragments in third-party retention.
    // The full err.message is captured in Sentry + the structured log above.
    return jsonError(503, "transient_failure", "resolve threw");
  } finally {
    span.end();
  }
};
