export type Sort = "recent" | "title" | "author" | "reading";

export type FeedRow = {
  highlight_id: string;
  book_hash: string;
  book_title: string | null;
  book_author: string | null;
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
      rows.push(r as FeedRow);
    }
  }
  return rows;
}
