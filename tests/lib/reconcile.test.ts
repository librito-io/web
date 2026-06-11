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
