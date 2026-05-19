import type { Sort } from "./types";

export function buildFeedUrl(params: {
  sort: Sort;
  cursor: string | null;
  bookHash?: string;
}): string {
  const qs = new URLSearchParams({ sort: params.sort });
  if (params.bookHash) qs.set("book_hash", params.bookHash);
  if (params.cursor) qs.set("cursor", params.cursor);
  return `/app/feed?${qs}`;
}
