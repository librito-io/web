import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { resolveIsbn } from "$lib/server/catalog/fetcher";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
} from "$lib/server/ratelimit";
import { coverUrl } from "$lib/server/cover-storage";
import { runInBackground } from "$lib/server/wait-until";
import {
  hasCoverStorage,
  type BookCatalogRow,
  type CoverVariant,
} from "$lib/server/catalog/types";

const PLACEHOLDER_URL = "/cover-placeholder.svg";

export const GET: RequestHandler = async (event) => {
  const { user } = await event.locals.safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Sign in required");

  const isbn = canonicalizeIsbn(event.params.isbn);
  if (!isbn) return jsonError(400, "invalid_isbn", "ISBN failed validation");

  const supabase = createAdminClient();
  const variant = (event.url.searchParams.get("variant") ??
    "medium") as CoverVariant;

  const { data: rawData, error } = await supabase
    .from("book_catalog")
    .select(
      "isbn, title, author, description, description_provider, publisher, " +
        "page_count, subjects, published_date, language, series_name, series_position, " +
        "storage_path, cover_storage_backend",
    )
    .eq("isbn", isbn)
    .maybeSingle();
  if (error) return jsonError(500, "server_error", "catalog lookup failed");
  // Cast at the boundary to the discriminated union (not `Partial<...>`) so
  // `hasCoverStorage` narrows cleanly. The projected select must list every
  // field accessed below — TypeScript no longer guards against missing
  // columns under this cast.
  const data = rawData as BookCatalogRow | null;

  if (!data || !hasCoverStorage(data)) {
    runInBackground(event, () =>
      resolveIsbn(supabase, isbn, {
        rateLimiters: {
          openLibrary: catalogOpenLibraryLimiter,
          googleBooks: catalogGoogleBooksLimiter,
        },
      }).then(() => undefined),
    );
    return jsonSuccess({
      isbn,
      cover_url: PLACEHOLDER_URL,
      title: data?.title ?? null,
      author: data?.author ?? null,
      description: data?.description ?? null,
      description_provider: data?.description_provider ?? null,
      publisher: data?.publisher ?? null,
      page_count: data?.page_count ?? null,
      subjects: data?.subjects ?? null,
      published_date: data?.published_date ?? null,
      language: data?.language ?? null,
      series_name: data?.series_name ?? null,
      series_position: data?.series_position ?? null,
      cold_miss: true,
    });
  }

  return jsonSuccess({
    isbn,
    cover_url: coverUrl(data.storage_path, data.cover_storage_backend, variant),
    title: data.title,
    author: data.author,
    description: data.description,
    description_provider: data.description_provider,
    publisher: data.publisher,
    page_count: data.page_count,
    subjects: data.subjects,
    published_date: data.published_date,
    language: data.language,
    series_name: data.series_name,
    series_position: data.series_position,
    cold_miss: false,
  });
};
