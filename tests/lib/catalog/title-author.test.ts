import { describe, it, expect } from "vitest";
import { normalizeTitleAuthor } from "../../../src/lib/server/catalog/title-author";

describe("normalizeTitleAuthor", () => {
  it("lowercases and strips punctuation", () => {
    expect(
      normalizeTitleAuthor("The Great Gatsby!", "F. Scott Fitzgerald"),
    ).toBe("the great gatsby|f scott fitzgerald");
  });

  it("collapses internal whitespace and trims", () => {
    expect(
      normalizeTitleAuthor(
        "  A  Tale  of  Two  Cities  ",
        " Charles  Dickens ",
      ),
    ).toBe("a tale of two cities|charles dickens");
  });

  it("handles unicode punctuation (curly quotes, em dash)", () => {
    expect(normalizeTitleAuthor("Don't Stop—Now", "Foo")).toBe(
      "dont stopnow|foo",
    );
  });

  it("returns null when title or author is empty after normalization", () => {
    expect(normalizeTitleAuthor("", "x")).toBeNull();
    expect(normalizeTitleAuthor("x", "")).toBeNull();
    expect(normalizeTitleAuthor("---", "...")).toBeNull();
  });
});
