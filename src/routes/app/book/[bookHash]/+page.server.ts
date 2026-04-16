import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { parseSort, SORT_COOKIE } from "$lib/feed/sort";
import { encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedRow, Sort } from "$lib/feed/types";

export const load: PageServerLoad = async ({
  params,
  cookies,
  locals: { supabase, safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) error(401, "Not authenticated");

  const bookHash = params.bookHash;
  const sort: Sort = parseSort(cookies.get(SORT_COOKIE), "reading");
  // cookie value may be title/author — fall back to reading on book page
  const effectiveSort: Sort =
    sort === "reading" || sort === "recent" ? sort : "reading";

  const bookQuery = supabase
    .from("books")
    .select("id, book_hash, title, author")
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

  if (feedRes.error) {
    console.error("get_highlight_feed failed", feedRes.error);
    return {
      book: bookRes.data,
      rows: [] as FeedRow[],
      nextCursor: null,
      sort: effectiveSort,
    };
  }

  const rows = parseFeedRows(feedRes.data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;
  return {
    book: bookRes.data,
    rows,
    nextCursor,
    sort: effectiveSort,
  };
};
