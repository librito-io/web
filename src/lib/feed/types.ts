export type Sort = "recent" | "title" | "author" | "reading";

export type FeedRow = {
  highlight_id: string;
  book_hash: string;
  book_title: string | null;
  book_author: string | null;
  // RPC RETURNS TABLE drops column nullability — gen:types emits `string`,
  // but books.isbn is nullable; normalized at parseFeedRows.
  book_isbn: string | null;
  book_highlight_count: number;
  chapter_index: number;
  chapter_title: string | null;
  start_word: number;
  end_word: number;
  text: string;
  styles: string | null;
  paragraph_breaks: number[] | null;
  note_text: string | null;
  note_updated_at: string | null;
  updated_at: string;
  next_cursor: Record<string, unknown> | null;
};

export type FeedPage = {
  rows: FeedRow[];
  nextCursor: string | null;
};

/**
 * Page-side view model. `FeedRow` is the RPC contract; `FeedItem` is what the
 * loader / paginated API hands the page. `coverUrl` is server-resolved from
 * `book_isbn` against `book_catalog` at request time; `null` means cold-miss,
 * ISBN-less, or negative-cache — caller renders the placeholder.
 */
export type FeedItem = FeedRow & { coverUrl: string | null };

export function parseFeedRows(data: unknown): FeedRow[] {
  if (!Array.isArray(data)) return [];
  const rows: FeedRow[] = [];
  for (const r of data) {
    if (
      r !== null &&
      typeof r === "object" &&
      typeof (r as { highlight_id?: unknown }).highlight_id === "string" &&
      typeof (r as { book_hash?: unknown }).book_hash === "string" &&
      typeof (r as { text?: unknown }).text === "string"
    ) {
      const rawIsbn = (r as { book_isbn?: unknown }).book_isbn;
      const book_isbn =
        typeof rawIsbn === "string" && rawIsbn.length > 0 ? rawIsbn : null;
      rows.push({ ...(r as FeedRow), book_isbn });
    }
  }
  return rows;
}
