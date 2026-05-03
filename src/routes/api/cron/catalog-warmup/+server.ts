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
} from "$lib/server/ratelimit";
import { getCatalogMutex } from "$lib/server/catalog/mutex";
import { CRON_SECRET, CATALOG_WARMUP_ENABLED } from "$env/static/private";
import { env as privateEnv } from "$env/dynamic/private";

const MAX_PER_RUN = 100;

export const POST: RequestHandler = async ({ request, fetch }) => {
  const auth = request.headers.get("authorization") ?? "";
  if (!constantTimeEqualString(auth, `Bearer ${CRON_SECRET}`)) {
    return jsonError(401, "unauthorized", "Cron secret mismatch");
  }
  if (CATALOG_WARMUP_ENABLED !== "true") {
    return jsonSuccess({ skipped: true });
  }

  const bodyIsbns = await parseIsbnsFromBody(request);

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
      console.warn("catalog_warmup_resolve_failed", {
        isbn,
        error: String(err),
      });
    }
  }

  const source = bodyIsbns ? "body" : "nyt";
  const durationMs = Date.now() - start;
  console.log(
    JSON.stringify({
      cron: "catalog-warmup",
      source,
      candidates: candidates.length,
      resolved,
      rateLimited,
      durationMs,
    }),
  );
  return jsonSuccess({
    source,
    candidates: candidates.length,
    resolved,
    rateLimited,
    durationMs,
  });
};
