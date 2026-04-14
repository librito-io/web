import { describe, it, expect } from "vitest";
import { renderStyledText } from "../../src/lib/rendering/styledText";

describe("renderStyledText", () => {
  it("returns a single regular run when styles are empty", () => {
    expect(renderStyledText("hello world")).toEqual([
      { text: "hello world", bold: false, italic: false },
    ]);
  });

  it("parses sequential R/B/I runs with character counts", () => {
    // text length = 45 + 12 + 5 = 62
    const text = "a".repeat(45) + "b".repeat(12) + "c".repeat(5);
    const runs = renderStyledText(text, "R45B12I5");
    expect(runs).toEqual([
      { text: "a".repeat(45), bold: false, italic: false },
      { text: "b".repeat(12), bold: true, italic: false },
      { text: "c".repeat(5), bold: false, italic: true },
    ]);
  });

  it("handles consecutive runs of the same style code", () => {
    const text = "xxxxyyy";
    const runs = renderStyledText(text, "R4R3");
    expect(runs).toEqual([
      { text: "xxxx", bold: false, italic: false },
      { text: "yyy", bold: false, italic: false },
    ]);
  });

  it("falls back to a single regular run when styles do not parse", () => {
    expect(renderStyledText("abc", "garbage")).toEqual([
      { text: "abc", bold: false, italic: false },
    ]);
  });

  it("falls back when run lengths overflow text length", () => {
    expect(renderStyledText("abc", "R99")).toEqual([
      { text: "abc", bold: false, italic: false },
    ]);
  });

  it("splits runs on embedded newlines so callers can render paragraph breaks", () => {
    // "\n" in text indicates paragraph break; run should not span across it.
    const text = "first\nsecond";
    const runs = renderStyledText(text, "R12");
    expect(runs).toEqual([
      { text: "first", bold: false, italic: false },
      { text: "\n", bold: false, italic: false, isBreak: true },
      { text: "second", bold: false, italic: false },
    ]);
  });
});
