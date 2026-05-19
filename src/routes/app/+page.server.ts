import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { parseSort, SORT_COOKIE } from "$lib/feed/sort";
import { encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedItem, Sort } from "$lib/feed/types";
import { enrichFeedRowsWithCovers } from "$lib/server/catalog/feed-enrichment";
import { logger } from "$lib/server/log";

export const load: PageServerLoad = async (event) => {
  const {
    cookies,
    locals: { supabase, safeGetSession },
  } = event;
  const { user } = await safeGetSession();
  const sort: Sort = parseSort(cookies.get(SORT_COOKIE), "recent");

  if (!user) redirect(303, "/auth/login");

  const { data, error } = await supabase.rpc("get_highlight_feed", {
    p_sort: sort,
    p_cursor: null,
    p_limit: 50,
    p_book_hash: null,
  });

  if (error) {
    logger().error(
      {
        event: "app.feed.rpc_failed",
        error: error.message,
      },
      "app.feed.rpc_failed",
    );
    return { items: [] as FeedItem[], nextCursor: null, sort };
  }

  const rows = parseFeedRows(data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;

  const items = await enrichFeedRowsWithCovers(supabase, user.id, rows);

  return { items, nextCursor, sort };
};
