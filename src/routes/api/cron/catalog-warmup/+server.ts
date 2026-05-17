import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { parseIsbnsFromBody } from "$lib/server/catalog/parse";
import { resolveIsbn } from "$lib/server/catalog/fetcher";
import { fetchNytBestsellerIsbns } from "$lib/server/catalog/nyt";
import { constantTimeEqualString } from "$lib/server/cron-auth";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogITunesLimiter,
} from "$lib/server/ratelimit";
import { getCatalogMutex } from "$lib/server/catalog/mutex";
// CRON_SECRET and CATALOG_WARMUP_ENABLED are Sensitive in Vercel; static
// imports bake empty values into prebuilt deploys (vercel pull redacts
// sensitive vars). Read at runtime via dynamic/private instead.
import { env as privateEnv } from "$env/dynamic/private";
import { logger } from "$lib/server/log";

const MAX_PER_RUN = 100;

async function runWarmup(
  bodyIsbns: string[] | null,
  fetch: typeof globalThis.fetch,
): Promise<Response> {
  const supabase = createAdminClient();
  const start = Date.now();
  const nytKey = privateEnv.NYT_BOOKS_API_KEY ?? "";
  const candidates = bodyIsbns
    ? bodyIsbns
    : await fetchNytBestsellerIsbns(nytKey, fetch);

  const toResolve = candidates.slice(0, MAX_PER_RUN);

  const mutex = await getCatalogMutex();

  let resolved = 0;
  let rateLimited = 0;
  for (const isbn of toResolve) {
    try {
      const r = await resolveIsbn(supabase, isbn, {
        rateLimiters: {
          openLibrary: catalogOpenLibraryLimiter,
          googleBooks: catalogGoogleBooksLimiter,
          itunes: catalogITunesLimiter,
        },
        mutex,
      });
      if (r.rateLimited) {
        rateLimited += 1;
        // Pacing — bail out for this run; budget will be replenished by next week.
        break;
      }
      resolved += 1;
    } catch (err) {
      logger().warn(
        {
          event: "catalog_warmup_resolve_failed",
          isbn,
          error: String(err),
        },
        "catalog_warmup_resolve_failed",
      );
    }
  }

  const source = bodyIsbns ? "body" : "nyt";
  const durationMs = Date.now() - start;
  logger().info(
    {
      event: "cron.catalog_warmup",
      source,
      candidates: candidates.length,
      resolved,
      rateLimited,
      durationMs,
    },
    "cron.catalog_warmup",
  );
  return jsonSuccess({
    source,
    candidates: candidates.length,
    resolved,
    rateLimited,
    durationMs,
  });
}

function authorized(request: Request): boolean {
  const secret = privateEnv.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization") ?? "";
  return constantTimeEqualString(auth, `Bearer ${secret}`);
}

// Vercel cron invokes scheduled paths via GET (no body). See issue #187.
export const GET: RequestHandler = async ({ request, fetch, url }) => {
  if (!privateEnv.CRON_SECRET) {
    return jsonError(500, "server_misconfigured", "CRON_SECRET unset");
  }
  if (!authorized(request)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }
  // ?probe=1 lets the deploy-time smoke check exercise auth + reachability
  // without triggering an actual warmup — running one per deploy would
  // burn NYT/OpenLibrary/GoogleBooks API budget and upload covers needlessly.
  // Gated behind successful auth so unauthenticated callers can't short-circuit.
  if (url.searchParams.get("probe") === "1") {
    return jsonSuccess({ probe: true });
  }
  if (privateEnv.CATALOG_WARMUP_ENABLED !== "true") {
    return jsonSuccess({ skipped: true });
  }
  return runWarmup(null, fetch);
};

// POST path retained for operator-triggered bulk seeds with explicit ISBN
// list in the JSON body (scripts/data/README.md).
export const POST: RequestHandler = async ({ request, fetch }) => {
  if (!privateEnv.CRON_SECRET) {
    return jsonError(500, "server_misconfigured", "CRON_SECRET unset");
  }
  if (!authorized(request)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }
  if (privateEnv.CATALOG_WARMUP_ENABLED !== "true") {
    return jsonSuccess({ skipped: true });
  }
  const bodyIsbns = await parseIsbnsFromBody(request);
  return runWarmup(bodyIsbns, fetch);
};
