import { describe, it, expect } from "vitest";
import { parseFeedRows } from "$lib/feed/types";
import type { FeedRow } from "$lib/feed/types";

// Complete fixture so each case only overrides the field under test.
function makeRow(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    highlight_id: "h-1",
    book_hash: "abc123",
    book_title: "Test Book",
    book_author: "Test Author",
    book_isbn: null,
    book_highlight_count: 1,
    chapter_index: 0,
    chapter_title: null,
    start_word: 0,
    end_word: 10,
    text: "some highlight text",
    styles: null,
    paragraph_breaks: null,
    note_text: null,
    note_updated_at: null,
    updated_at: "2026-01-01T00:00:00Z",
    next_cursor: null,
    ...overrides,
  };
}

describe("parseFeedRows", () => {
  describe("book_isbn normalization", () => {
    it("preserves a valid ISBN string", () => {
      const rows = parseFeedRows([makeRow({ book_isbn: "9781234567890" })]);
      expect(rows).toHaveLength(1);
      expect(rows[0].book_isbn).toBe("9781234567890");
    });

    it("normalizes null to null", () => {
      const rows = parseFeedRows([makeRow({ book_isbn: null })]);
      expect(rows).toHaveLength(1);
      expect(rows[0].book_isbn).toBeNull();
    });

    it("normalizes empty string to null", () => {
      const rows = parseFeedRows([{ ...makeRow(), book_isbn: "" }]);
      expect(rows).toHaveLength(1);
      expect(rows[0].book_isbn).toBeNull();
    });

    it("normalizes missing book_isbn key to null", () => {
      const row = makeRow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (row as any).book_isbn;
      const rows = parseFeedRows([row]);
      expect(rows).toHaveLength(1);
      expect(rows[0].book_isbn).toBeNull();
    });

    it("normalizes wrong type (number) to null", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = parseFeedRows([{ ...makeRow(), book_isbn: 12345 as any }]);
      expect(rows).toHaveLength(1);
      expect(rows[0].book_isbn).toBeNull();
    });
  });

  describe("existing gate behavior (unchanged by book_isbn)", () => {
    it("returns empty array for non-array input", () => {
      expect(parseFeedRows(null)).toEqual([]);
      expect(parseFeedRows("not-array")).toEqual([]);
      expect(parseFeedRows({})).toEqual([]);
    });

    it("drops rows missing highlight_id", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = { ...makeRow(), highlight_id: undefined as any };
      expect(parseFeedRows([row])).toHaveLength(0);
    });

    it("drops rows missing book_hash", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = { ...makeRow(), book_hash: undefined as any };
      expect(parseFeedRows([row])).toHaveLength(0);
    });

    it("drops rows missing text", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = { ...makeRow(), text: undefined as any };
      expect(parseFeedRows([row])).toHaveLength(0);
    });
  });
});
