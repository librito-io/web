import { describe, it, expect } from "vitest";
import {
  parseSort,
  SORT_COOKIE,
  FEED_SORT_OPTIONS,
  BOOK_SORT_OPTIONS,
} from "$lib/feed/sort";

describe("parseSort", () => {
  it("accepts a valid value", () => {
    expect(parseSort("recent", "recent")).toBe("recent");
    expect(parseSort("title", "recent")).toBe("title");
    expect(parseSort("author", "recent")).toBe("author");
    expect(parseSort("reading", "recent")).toBe("reading");
  });

  it("falls back on unknown value", () => {
    expect(parseSort("nonsense", "recent")).toBe("recent");
  });

  it("falls back on null / undefined / empty", () => {
    expect(parseSort(null, "recent")).toBe("recent");
    expect(parseSort(undefined, "reading")).toBe("reading");
    expect(parseSort("", "reading")).toBe("reading");
  });
});

describe("constants", () => {
  it("SORT_COOKIE is librito_sort", () => {
    expect(SORT_COOKIE).toBe("librito_sort");
  });

  it("FEED_SORT_OPTIONS are recent/title/author", () => {
    expect(FEED_SORT_OPTIONS.map((o) => o.value)).toEqual([
      "recent",
      "title",
      "author",
    ]);
  });

  it("BOOK_SORT_OPTIONS are reading/recent", () => {
    expect(BOOK_SORT_OPTIONS.map((o) => o.value)).toEqual([
      "reading",
      "recent",
    ]);
  });
});
