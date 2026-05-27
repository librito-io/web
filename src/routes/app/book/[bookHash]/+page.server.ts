import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { parseSort, SORT_COOKIE } from "$lib/feed/sort";
import { encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedItem, Sort } from "$lib/feed/types";
import { canonicalizeIsbn } from "$lib/server/catalog/isbn";
import { normalizeTitleAuthor } from "$lib/server/catalog/title-author";
import {
  getCatalogForBrowser,
  getCatalogForBrowserByTitleAuthor,
  type BookDetailCatalog,
  type CatalogView,
} from "$lib/server/catalog/view";
import { enrichFeedRowsWithCovers } from "$lib/server/catalog/feed-enrichment";
import { scheduleCatalogResolveIfAllowed } from "$lib/server/catalog/scheduling";
import { logger } from "$lib/server/log";

export const load: PageServerLoad = async (event) => {
  const {
    params,
    cookies,
    parent,
    locals: { supabase },
  } = event;

  const { user } = await parent();

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

  const userId = user.id;

  if (isbn) {
    const view: CatalogView | null = await getCatalogForBrowser(
      supabase,
      isbn,
      "large",
    ).catch(() => null);
    if (view && view.cover_url !== null) {
      catalog = projectCatalogView(view);
    } else if (view === null) {
      // ctx carries title+author so the resolver can promote a pre-existing
      // TA-keyed catalog row to ISBN-keyed instead of creating a duplicate
      // (issue #427, refit PR3). title + author are non-null in practice
      // (device sync writes both) but the books schema allows NULL on each;
      // resolveIsbn tolerates that via its `ctx?.title && ctx?.author`
      // guard — promote-on-resolve simply doesn't fire when either side
      // is missing.
      await scheduleCatalogResolveIfAllowed(userId, [
        {
          kind: "isbn",
          isbn,
          ctx: { title: bookRow.title, author: bookRow.author },
        },
      ]);
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
    const view: CatalogView | null = await getCatalogForBrowserByTitleAuthor(
      supabase,
      title,
      author,
      "large",
    ).catch(() => null);
    if (view && view.cover_url !== null) {
      catalog = projectCatalogView(view);
    } else if (view === null) {
      await scheduleCatalogResolveIfAllowed(userId, [
        { kind: "ta", title, author },
      ]);
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
  // Match the home-feed loader and pagination handler: every card gets a
  // resolved coverUrl thumbnail. Issue #111: the prior `coverUrl: null` map
  // here diverged from `/app/feed/+server.ts`, so cards 1-50 rendered
  // placeholder while paginated cards 51+ rendered thumbnails, and a sort
  // change (which re-fetches everything through pagination) flipped all
  // cards to enriched. All three feed surfaces now go through the same
  // enrichment pipeline.
  const items: FeedItem[] = await enrichFeedRowsWithCovers(
    supabase,
    user.id,
    rows,
  );
  return {
    book: bookRow,
    catalog,
    items,
    nextCursor,
    sort: effectiveSort,
  };
};
