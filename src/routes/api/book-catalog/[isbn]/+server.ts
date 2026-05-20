import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { resolveIsbn } from "$lib/server/catalog/fetcher";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogITunesLimiter,
  catalogUserLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { runInBackground } from "$lib/server/wait-until";
import {
  getCatalogForBrowser,
  toCatalogResponse,
  type CatalogView,
} from "$lib/server/catalog/view";
import { getCatalogMutex } from "$lib/server/catalog/mutex";
import type { CoverVariant } from "$lib/server/catalog/types";
// GOOGLE_BOOKS_API_KEY is Sensitive in Vercel; static-imported sensitive
// vars bake empty strings into prebuilt deploys. Read at runtime via
// dynamic/private. Anonymous Google Books quota is 0/day per project, so
// missing key silently degrades the entire premium-cover + description path.
import { env as privateEnv } from "$env/dynamic/private";

// Allowlist for the `variant` query param. The cloudflare-images backend
// interpolates the variant into a URL path segment, so an unvalidated `as`
// cast would let arbitrary strings flow through to the rendered cover URL.
const VALID_VARIANTS = new Set<CoverVariant>([
  "thumbnail",
  "medium",
  "large",
  "xlarge",
]);

export const GET: RequestHandler = async (event) => {
  const { user } = await event.locals.safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Sign in required");

  const isbn = canonicalizeIsbn(event.params.isbn);
  if (!isbn) return jsonError(400, "invalid_isbn", "ISBN failed validation");

  // Per-user limiter consumed once per request, ahead of any Supabase
  // round-trip — caps worst-case DB load on cold-miss spam at the
  // limiter budget (rather than at full request volume) and keeps
  // expensive cold-miss fan-out gated. Warm hits also consume one unit;
  // CLAUDE.md catalogUserLimiter doc records that bulk patterns are
  // intentionally gated and the 10/min budget covers normal browsing
  // with headroom.
  const limited = await enforceRateLimit(
    catalogUserLimiter,
    user.id,
    "Catalog lookup rate limit exceeded",
  );
  if (limited) return limited;

  const supabase = createAdminClient();
  const rawVariant = event.url.searchParams.get("variant");
  const variant: CoverVariant = VALID_VARIANTS.has(rawVariant as CoverVariant)
    ? (rawVariant as CoverVariant)
    : "medium";

  let catalogView: CatalogView | null;
  try {
    catalogView = await getCatalogForBrowser(supabase, isbn, variant);
  } catch {
    return jsonError(500, "server_error", "catalog lookup failed");
  }

  if (!catalogView || catalogView.cover_url === null) {
    const mutex = await getCatalogMutex();
    runInBackground(() =>
      resolveIsbn(supabase, isbn, {
        rateLimiters: {
          openLibrary: catalogOpenLibraryLimiter,
          googleBooks: catalogGoogleBooksLimiter,
          itunes: catalogITunesLimiter,
        },
        mutex,
        googleBooksApiKey: privateEnv.GOOGLE_BOOKS_API_KEY,
      }).then(() => undefined),
    );
  }

  return jsonSuccess(toCatalogResponse(catalogView, isbn));
};
