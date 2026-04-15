import type { RequestHandler } from "@sveltejs/kit";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { parseSort } from "$lib/feed/sort";
import { decodeCursor, encodeCursor } from "$lib/feed/cursor";
import { parseFeedRows } from "$lib/feed/types";

export const GET: RequestHandler = async ({
  url,
  locals: { supabase, safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Sign in required");

  const sort = parseSort(url.searchParams.get("sort"), "recent");
  const cursorParam = url.searchParams.get("cursor");
  const cursor = decodeCursor(cursorParam);
  if (cursorParam && cursor === null) {
    return jsonError(400, "bad_cursor", "Invalid cursor");
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
    return jsonError(500, "rpc_failed", "Feed query failed");
  }

  const rows = parseFeedRows(data);
  const last = rows.at(-1);
  const nextCursor = last?.next_cursor ? encodeCursor(last.next_cursor) : null;
  return jsonSuccess({ rows, nextCursor });
};
