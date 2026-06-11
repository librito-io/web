import { describe, it, expect } from "vitest";
import {
  normalizeText,
  containsAtWordBoundary,
  textMatch,
} from "$lib/server/import/reconcile";

describe("normalizeText", () => {
  it("collapses every whitespace run to a single space and trims", () => {
    expect(normalizeText("  he said   hello\n")).toBe("he said hello");
  });

  it("normalizes the literal Kobo leading tab-space prefix", () => {
    expect(normalizeText("\t the quick brown fox")).toBe("the quick brown fox");
  });

  it("collapses NBSP and unicode spaces via \\s (identical on both sides)", () => {
    // U+00A0 NBSP, U+2009 thin space.
    expect(normalizeText("a b c")).toBe("a b c");
  });

  it("does NOT case-fold or unicode-normalize", () => {
    expect(normalizeText("The CAFÉ")).toBe("The CAFÉ");
  });
});

describe("containsAtWordBoundary", () => {
  it("matches at the string edges (equality)", () => {
    expect(containsAtWordBoundary("he said hello", "he said hello")).toBe(true);
  });

  it("matches a whole-word run flanked by spaces", () => {
    expect(containsAtWordBoundary("a he said hello b", "he said hello")).toBe(
      true,
    );
  });

  it("rejects a mid-word containment (she said vs he said)", () => {
    // "he said hello to everyone" must NOT match inside "she said hello to everyone".
    expect(
      containsAtWordBoundary(
        "she said hello to everyone",
        "he said hello to everyone",
      ),
    ).toBe(false);
  });

  it("rejects an empty needle", () => {
    expect(containsAtWordBoundary("anything", "")).toBe(false);
  });

  it("matches a needle anchored at the end of a longer haystack", () => {
    expect(containsAtWordBoundary("hello world", "world")).toBe(true);
  });
});

describe("textMatch", () => {
  it("is true when the shorter contains the longer-side at boundaries (either direction)", () => {
    expect(textMatch("he said hello", "well he said hello there")).toBe(true);
    expect(textMatch("well he said hello there", "he said hello")).toBe(true);
  });

  it("is true on equality", () => {
    expect(textMatch("he said hello", "he said hello")).toBe(true);
  });

  it("is false when neither contains the other", () => {
    expect(textMatch("he said hello", "she said goodbye")).toBe(false);
  });

  it("equal length but different strings do not match", () => {
    expect(textMatch("abcde", "abcdf")).toBe(false);
  });
});

import { __pairOverlap } from "$lib/server/import/reconcile";
import type {
  ExistingHighlight,
  IncomingItem,
} from "$lib/server/import/reconcile";

function ex(overrides: Partial<ExistingHighlight> = {}): ExistingHighlight {
  return {
    id: "ex-1",
    book_id: "book-1",
    source: "kobo",
    source_uid: "old-uid",
    text: "the quick brown fox jumps over",
    chapter_title: null,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function inc(overrides: Partial<IncomingItem> = {}): IncomingItem {
  return {
    book_id: "book-1",
    source_uid: "new-uid",
    text: "the quick brown fox jumps over",
    chapter_title: null,
    ...overrides,
  };
}

describe("__pairOverlap guards", () => {
  it("returns the shorter normalized length when contained and >= 20", () => {
    // "the quick brown fox jumps" is 25 chars, contained in the longer text.
    const a = ex({ text: "the quick brown fox jumps" });
    const n = inc({ text: "well the quick brown fox jumps over the lazy dog" });
    expect(__pairOverlap(a, n)).toBe(25);
  });

  it("returns null when texts do not match", () => {
    expect(
      __pairOverlap(ex({ text: "completely different words here" }), inc()),
    ).toBeNull();
  });

  it("length floor: 19 rejects, 20 accepts, 21 accepts", () => {
    const t19 = "a".repeat(9) + " " + "b".repeat(9); // 19 chars
    const t20 = "a".repeat(9) + " " + "b".repeat(10); // 20 chars
    const t21 = "a".repeat(10) + " " + "b".repeat(10); // 21 chars
    expect(__pairOverlap(ex({ text: t19 }), inc({ text: t19 }))).toBeNull();
    expect(__pairOverlap(ex({ text: t20 }), inc({ text: t20 }))).toBe(20);
    expect(__pairOverlap(ex({ text: t21 }), inc({ text: t21 }))).toBe(21);
  });

  it("chapter gate: both non-empty + different → no match", () => {
    const a = ex({ chapter_title: "Chapter One" });
    const n = inc({ chapter_title: "Chapter Two" });
    expect(__pairOverlap(a, n)).toBeNull();
  });

  it("chapter gate: empty/null on either side passes", () => {
    expect(
      __pairOverlap(
        ex({ chapter_title: null }),
        inc({ chapter_title: "Chapter Two" }),
      ),
    ).not.toBeNull();
    expect(
      __pairOverlap(
        ex({ chapter_title: "Chapter One" }),
        inc({ chapter_title: "" }),
      ),
    ).not.toBeNull();
  });

  it("chapter gate compares after whitespace normalization", () => {
    // Same chapter, differing only by whitespace → must NOT block.
    const a = ex({ chapter_title: "Chapter   One" });
    const n = inc({ chapter_title: " Chapter One " });
    expect(__pairOverlap(a, n)).not.toBeNull();
  });
});
