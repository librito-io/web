import { describe, expect, it } from "vitest";
import { mergeHead, dedupeById } from "$lib/feed/merge";
import type { FeedItem } from "$lib/feed/types";

// Minimal FeedItem factory — only highlight_id matters for these pure helpers.
function item(id: string): FeedItem {
  return {
    highlight_id: id,
    book_hash: "b",
    book_title: "t",
    book_author: "a",
    book_isbn: null,
    book_highlight_count: 1,
    chapter_index: 0,
    chapter_title: null,
    start_word: 0,
    end_word: 1,
    text: id,
    styles: null,
    paragraph_breaks: null,
    note_text: null,
    note_updated_at: null,
    updated_at: "2026-06-21T00:00:00Z",
    next_cursor: null,
    coverUrl: null,
  };
}

const ids = (xs: FeedItem[]): string[] => xs.map((x) => x.highlight_id);

describe("mergeHead", () => {
  it("prepends a fresh head row in front of the loaded tail", () => {
    const out = mergeHead([item("new"), item("a")], [item("a"), item("b")]);
    expect(ids(out)).toEqual(["new", "a", "b"]);
  });

  it("dedupes overlap on highlight_id, head order wins", () => {
    const out = mergeHead([item("a"), item("b")], [item("b"), item("c")]);
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  it("returns existing unchanged when head is empty", () => {
    const out = mergeHead([], [item("a"), item("b")]);
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("returns head when existing is empty", () => {
    const out = mergeHead([item("a")], []);
    expect(ids(out)).toEqual(["a"]);
  });
});

describe("dedupeById", () => {
  it("removes a duplicate that appears across adjacent pages, preserving order", () => {
    // page1 = [a,b], page2 overlaps b because an insert shifted the keyset
    const out = dedupeById([item("a"), item("b"), item("b"), item("c")]);
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op on an already-unique list", () => {
    const out = dedupeById([item("a"), item("b")]);
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("handles the empty list", () => {
    expect(dedupeById([])).toEqual([]);
  });
});
