import type { FeedItem } from "./types";

/**
 * Insert path: prepend the freshly-refetched head, then keep the previously-
 * loaded tail that sits below it. Dedupe on `highlight_id` so a row present in
 * both the head and the old tail is not duplicated; head order wins.
 */
export function mergeHead(head: FeedItem[], existing: FeedItem[]): FeedItem[] {
  const headIds = new Set(head.map((i) => i.highlight_id));
  return [...head, ...existing.filter((i) => !headIds.has(i.highlight_id))];
}

/**
 * Restore / reconnect path: the loaded range is refetched as one or more pages
 * and concatenated; a row can appear in two adjacent pages when an insert
 * shifts the keyset between page fetches. Dedupe by `highlight_id`, preserving
 * first occurrence (server order).
 */
export function dedupeById(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const it of items) {
    if (seen.has(it.highlight_id)) continue;
    seen.add(it.highlight_id);
    out.push(it);
  }
  return out;
}
