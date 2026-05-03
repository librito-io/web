import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { resolveIsbn } from "$lib/server/catalog/fetcher";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogUserLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { runInBackground } from "$lib/server/wait-until";
import { getCatalogForBrowser } from "$lib/server/catalog/view";
import { getCatalogMutex } from "$lib/server/catalog/mutex";
import type { CoverVariant } from "$lib/server/catalog/types";

const PLACEHOLDER_URL = "/cover-placeholder.svg";

export const GET: RequestHandler = async (event) => {
  const { user } = await event.locals.safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Sign in required");

  const isbn = canonicalizeIsbn(event.params.isbn);
  if (!isbn) return jsonError(400, "invalid_isbn", "ISBN failed validation");

  const supabase = createAdminClient();
  const variant = (event.url.searchParams.get("variant") ??
    "medium") as CoverVariant;

  let catalogView;
  try {
    catalogView = await getCatalogForBrowser(supabase, isbn, variant);
  } catch {
    return jsonError(500, "server_error", "catalog lookup failed");
  }

  if (!catalogView || catalogView.cover_url === null) {
    // Per-user budget on cold-miss work-scheduling. Layered with the
    // per-deployment fail-open limiters inside resolveIsbn — see
    // catalogUserLimiter doc in ratelimit.ts. Hit path (above) does not
    // run the limiter; users reading already-cached data never see 429.
    const limited = await enforceRateLimit(
      catalogUserLimiter,
      user.id,
      "Catalog lookup rate limit exceeded",
    );
    if (limited) return limited;
    const mutex = await getCatalogMutex();
    runInBackground(event, () =>
      resolveIsbn(supabase, isbn, {
        rateLimiters: {
          openLibrary: catalogOpenLibraryLimiter,
          googleBooks: catalogGoogleBooksLimiter,
        },
        mutex,
      }).then(() => undefined),
    );
    return jsonSuccess({
      isbn,
      cover_url: PLACEHOLDER_URL,
      title: catalogView?.title ?? null,
      author: catalogView?.author ?? null,
      description: catalogView?.description ?? null,
      description_provider: catalogView?.description_provider ?? null,
      publisher: catalogView?.publisher ?? null,
      page_count: catalogView?.page_count ?? null,
      subjects: catalogView?.subjects ?? null,
      published_date: catalogView?.published_date ?? null,
      language: catalogView?.language ?? null,
      series_name: catalogView?.series_name ?? null,
      series_position: catalogView?.series_position ?? null,
      cold_miss: true,
    });
  }

  return jsonSuccess({
    isbn,
    cover_url: catalogView.cover_url,
    title: catalogView.title,
    author: catalogView.author,
    description: catalogView.description,
    description_provider: catalogView.description_provider,
    publisher: catalogView.publisher,
    page_count: catalogView.page_count,
    subjects: catalogView.subjects,
    published_date: catalogView.published_date,
    language: catalogView.language,
    series_name: catalogView.series_name,
    series_position: catalogView.series_position,
    cold_miss: false,
  });
};
