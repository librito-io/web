import type { PageServerLoad } from "./$types";
import { parseSort, SORT_COOKIE } from "$lib/feed/sort";
import { encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedRow, Sort } from "$lib/feed/types";

export const load: PageServerLoad = async ({
  cookies,
  locals: { supabase, safeGetSession },
}) => {
  const { user } = await safeGetSession();
  const sort: Sort = parseSort(cookies.get(SORT_COOKIE), "recent");

  if (!user) {
    return { rows: [] as FeedRow[], nextCursor: null, sort };
  }

  const { data, error } = await supabase.rpc("get_highlight_feed", {
    p_sort: sort,
    p_cursor: null,
    p_limit: 50,
    p_book_hash: null,
  });

  if (error) {
    console.error("get_highlight_feed failed", error);
    return { rows: [] as FeedRow[], nextCursor: null, sort };
  }

  const rows = parseFeedRows(data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;
  return { rows, nextCursor, sort };
};
