import { json, type RequestHandler } from "@sveltejs/kit";
import { parseSort } from "$lib/feed/sort";
import { decodeCursor, encodeCursor } from "$lib/feed/cursor";
import type { FeedRow } from "$lib/feed/types";

export const GET: RequestHandler = async ({
  url,
  locals: { supabase, safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return json({ error: "unauthorized" }, { status: 401 });

  const sort = parseSort(url.searchParams.get("sort"), "recent");
  const cursorParam = url.searchParams.get("cursor");
  const cursor = decodeCursor(cursorParam);
  if (cursorParam && cursor === null) {
    return json({ error: "bad_cursor" }, { status: 400 });
  }
  const bookHash = url.searchParams.get("book_hash");

  const { data, error } = await supabase.rpc("get_highlight_feed", {
    p_sort: sort,
    p_cursor: cursor,
    p_limit: 50,
    p_book_hash: bookHash,
  });

  if (error) {
    console.error("/app/feed rpc error", error);
    return json({ error: "rpc_failed" }, { status: 500 });
  }

  const rows = (data ?? []) as FeedRow[];
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;
  return json({ rows, nextCursor });
};
