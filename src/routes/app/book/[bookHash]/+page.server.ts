import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { parseSort, SORT_COOKIE } from "$lib/feed/sort";
import { encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedRow, Sort } from "$lib/feed/types";
import { createAdminClient } from "$lib/server/supabase";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { resolveIsbn } from "$lib/server/catalog/fetcher";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogUserLimiter,
  safeLimit,
} from "$lib/server/ratelimit";
import { coverUrl } from "$lib/server/cover-storage";
import { runInBackground } from "$lib/server/wait-until";
import {
  hasCoverStorage,
  type BookCatalogRow,
} from "$lib/server/catalog/types";

export const load: PageServerLoad = async (event) => {
  const {
    params,
    cookies,
    locals: { supabase, safeGetSession },
  } = event;

  const { user } = await safeGetSession();
  if (!user) error(401, "Not authenticated");

  const bookHash = params.bookHash;
  const sort: Sort = parseSort(cookies.get(SORT_COOKIE), "reading");
  // cookie value may be title/author — fall back to reading on book page
  const effectiveSort: Sort =
    sort === "reading" || sort === "recent" ? sort : "reading";

  const bookQuery = supabase
    .from("books")
    .select("id, book_hash, title, author, isbn")
    .eq("user_id", user.id)
    .eq("book_hash", bookHash)
    .maybeSingle();

  const feedQuery = supabase.rpc("get_highlight_feed", {
    p_sort: effectiveSort,
    p_cursor: null,
    p_limit: 50,
    p_book_hash: bookHash,
  });

  const [bookRes, feedRes] = await Promise.all([bookQuery, feedQuery]);

  if (bookRes.error) {
    console.error("book lookup failed", bookRes.error);
    error(500, "Failed to load book");
  }
  if (!bookRes.data) error(404, "Book not found");

  const bookRow = bookRes.data as {
    id: string;
    book_hash: string;
    title: string;
    author: string;
    isbn: string | null;
  };
  const isbn = canonicalizeIsbn(bookRow.isbn);

  let catalog: {
    cover_url: string;
    description: string | null;
    description_provider: string | null;
    publisher: string | null;
    page_count: number | null;
    subjects: string[] | null;
    published_date: string | null;
  } = {
    cover_url: "/cover-placeholder.svg",
    description: null,
    description_provider: null,
    publisher: null,
    page_count: null,
    subjects: null,
    published_date: null,
  };

  if (isbn) {
    const { data: rawCat, error: catError } = await supabase
      .from("book_catalog")
      .select(
        "storage_path, cover_storage_backend, description, description_provider, " +
          "publisher, page_count, subjects, published_date",
      )
      .eq("isbn", isbn)
      .maybeSingle();
    // Cast at the boundary: the projected select returns a structural subset
    // of the row. `Pick<BookCatalogRow, ...>` distributes across the
    // discriminated union (`Pick<A | B, K>` ≡ `Pick<A, K> | Pick<B, K>`),
    // so the storage discriminant is preserved and `hasCoverStorage`
    // narrows cleanly into the positive variant. Keep this Pick key list
    // in sync with the SELECT projection above — TS will error if a
    // non-projected column is accessed below.
    type BookDetailCatalogView = Pick<
      BookCatalogRow,
      | "storage_path"
      | "cover_storage_backend"
      | "description"
      | "description_provider"
      | "publisher"
      | "page_count"
      | "subjects"
      | "published_date"
    >;
    const cat = (rawCat as BookDetailCatalogView | null) ?? null;
    if (!catError && cat && hasCoverStorage(cat)) {
      catalog = {
        cover_url: coverUrl(
          cat.storage_path,
          cat.cover_storage_backend,
          "large",
        ),
        description: cat.description ?? null,
        description_provider: cat.description_provider ?? null,
        publisher: cat.publisher ?? null,
        page_count: cat.page_count ?? null,
        subjects: cat.subjects ?? null,
        published_date: cat.published_date ?? null,
      };
    } else {
      // Per-user budget on cold-miss work-scheduling. Page loader treats
      // any non-allowed outcome (denied, failClosed) as "skip schedule"
      // and renders the existing placeholder catalog state — returning
      // 429/503 from a load function would render an error page over
      // already-readable data. See catalogUserLimiter doc in ratelimit.ts.
      const outcome = await safeLimit(catalogUserLimiter, user.id);
      const allowed = outcome.kind === "ok" && outcome.result.success;
      if (allowed) {
        const admin = createAdminClient();
        runInBackground(event, () =>
          resolveIsbn(admin, isbn, {
            rateLimiters: {
              openLibrary: catalogOpenLibraryLimiter,
              googleBooks: catalogGoogleBooksLimiter,
            },
          }).then(() => undefined),
        );
      }
    }
  }

  if (feedRes.error) {
    console.error("get_highlight_feed failed", feedRes.error);
    return {
      book: bookRow,
      catalog,
      rows: [] as FeedRow[],
      nextCursor: null,
      sort: effectiveSort,
    };
  }

  const rows = parseFeedRows(feedRes.data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;
  return {
    book: bookRow,
    catalog,
    rows,
    nextCursor,
    sort: effectiveSort,
  };
};
