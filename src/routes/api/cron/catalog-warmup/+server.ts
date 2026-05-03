import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { resolveIsbn } from "$lib/server/catalog/fetcher";
import { fetchNytBestsellerIsbns } from "$lib/server/catalog/nyt";
import { constantTimeEqualString } from "$lib/server/cron-auth";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
} from "$lib/server/ratelimit";
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

  let bodyIsbns: string[] | null = null;
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = (await request.json()) as { isbns?: unknown };
      if (Array.isArray(body.isbns)) {
        bodyIsbns = body.isbns
          .map((s) => (typeof s === "string" ? canonicalizeIsbn(s) : null))
          .filter((s): s is string => !!s);
      }
    } catch {
      // Body parse failure — fall through to NYT default.
    }
  }

  const supabase = createAdminClient();
  const start = Date.now();
  const nytKey = privateEnv.NYT_BOOKS_API_KEY ?? "";
  const candidates = bodyIsbns
    ? bodyIsbns
    : await fetchNytBestsellerIsbns(nytKey, fetch);

  const toResolve = candidates.slice(0, MAX_PER_RUN);

  let resolved = 0;
  let rateLimited = 0;
  for (const isbn of toResolve) {
    try {
      const r = await resolveIsbn(supabase, isbn, {
        rateLimiters: {
          openLibrary: catalogOpenLibraryLimiter,
          googleBooks: catalogGoogleBooksLimiter,
        },
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
