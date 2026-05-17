import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { parseSort, SORT_COOKIE } from "$lib/feed/sort";
import { encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedItem, Sort } from "$lib/feed/types";
import { createAdminClient } from "$lib/server/supabase";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { normalizeTitleAuthor } from "$lib/server/catalog/title-author";
import { resolveIsbn, resolveTitleAuthor } from "$lib/server/catalog/fetcher";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogITunesLimiter,
  catalogUserLimiter,
  safeLimit,
} from "$lib/server/ratelimit";
import { runInBackground } from "$lib/server/wait-until";
import {
  getCatalogForBrowser,
  getCatalogForBrowserByTitleAuthor,
  type BookDetailCatalog,
  type CatalogView,
} from "$lib/server/catalog/view";
import { getCatalogMutex } from "$lib/server/catalog/mutex";
import { logger } from "$lib/server/log";

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
    logger().error(
      {
        event: "app.book.lookup_failed",
        error: bookRes.error.message,
      },
      "app.book.lookup_failed",
    );
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

  let catalog: BookDetailCatalog = {
    cover_url: "/cover-placeholder.svg",
    description: null,
    description_provider: null,
    publisher: null,
    page_count: null,
    subjects: null,
    published_date: null,
  };

  function projectCatalogView(view: CatalogView): BookDetailCatalog {
    return {
      // Caller is expected to have branched on view.cover_url !== null.
      cover_url: view.cover_url as string,
      description: view.description ?? null,
      description_provider: view.description_provider ?? null,
      publisher: view.publisher ?? null,
      page_count: view.page_count ?? null,
      subjects: view.subjects ?? null,
      published_date: view.published_date ?? null,
    };
  }

  // Per-user budget on cold-miss work-scheduling. Page loader treats any
  // non-allowed outcome (denied, failClosed) as "skip schedule" and renders
  // the existing placeholder catalog state — returning 429/503 from a load
  // function would render an error page over already-readable data. See
  // catalogUserLimiter doc in ratelimit.ts. Mutex acquisition runs inside
  // the runInBackground callback so the page load does not block on the
  // lazy Upstash singleton init.
  const userId = user.id;
  async function scheduleColdMissResolve(
    work: (
      mutex: Awaited<ReturnType<typeof getCatalogMutex>>,
    ) => Promise<unknown>,
  ): Promise<void> {
    const outcome = await safeLimit(catalogUserLimiter, userId);
    const allowed = outcome.kind === "ok" && outcome.result.success;
    if (!allowed) return;
    const mutexPromise = getCatalogMutex();
    runInBackground(event, async () => {
      const mutex = await mutexPromise;
      await work(mutex);
    });
  }

  if (isbn) {
    let view: CatalogView | null = null;
    let failed = false;
    try {
      view = await getCatalogForBrowser(supabase, isbn, "large");
    } catch {
      failed = true;
    }
    if (!failed && view && view.cover_url !== null) {
      catalog = projectCatalogView(view);
    } else if (!failed) {
      await scheduleColdMissResolve((mutex) => {
        const admin = createAdminClient();
        return resolveIsbn(admin, isbn, {
          rateLimiters: {
            openLibrary: catalogOpenLibraryLimiter,
            googleBooks: catalogGoogleBooksLimiter,
            itunes: catalogITunesLimiter,
          },
          mutex,
        });
      });
    }
  } else if (
    bookRow.title &&
    bookRow.author &&
    normalizeTitleAuthor(bookRow.title, bookRow.author)
  ) {
    // ISBN-null fallback for sideloaded EPUBs. Looks up the row keyed on
    // book_catalog.normalized_title_author (partial unique index, scope
    // `isbn IS NULL`); on cold miss schedules `resolveTitleAuthor` via the
    // per-(title,author) mutex namespace `catalog:lock:ta:${key}`, distinct
    // from `catalog:lock:isbn:${isbn}`.
    const title = bookRow.title;
    const author = bookRow.author;
    let view: CatalogView | null = null;
    let failed = false;
    try {
      view = await getCatalogForBrowserByTitleAuthor(
        supabase,
        title,
        author,
        "large",
      );
    } catch {
      failed = true;
    }
    if (!failed && view && view.cover_url !== null) {
      catalog = projectCatalogView(view);
    } else if (!failed) {
      await scheduleColdMissResolve((mutex) => {
        const admin = createAdminClient();
        return resolveTitleAuthor(admin, title, author, {
          rateLimiters: {
            openLibrary: catalogOpenLibraryLimiter,
            googleBooks: catalogGoogleBooksLimiter,
            itunes: catalogITunesLimiter,
          },
          mutex,
        });
      });
    }
  }

  if (feedRes.error) {
    logger().error(
      {
        event: "app.book.feed_rpc_failed",
        error: feedRes.error.message,
      },
      "app.book.feed_rpc_failed",
    );
    return {
      book: bookRow,
      catalog,
      items: [] as FeedItem[],
      nextCursor: null,
      sort: effectiveSort,
    };
  }

  const rows = parseFeedRows(feedRes.data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;
  // Book detail does not batch-resolve per-card covers — the book's cover is
  // already rendered at the top of the page and cards below it are
  // book-grouped, so a per-card thumbnail would be redundant.
  const items: FeedItem[] = rows.map((r) => ({ ...r, coverUrl: null }));
  return {
    book: bookRow,
    catalog,
    items,
    nextCursor,
    sort: effectiveSort,
  };
};
