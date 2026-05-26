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

  it("indexes by Unicode codepoints, not UTF-16 code units or UTF-8 bytes", () => {
    // Firmware (reader PR #50) emits styles indexed in codepoints. For
    // BMP-only text codepoints == UTF-16 units, so the bug never appeared
    // on ASCII. Smart-quote chars (U+2019, 1 codepoint, 1 UTF-16 unit,
    // 3 UTF-8 bytes) and astral chars (1 codepoint, 2 UTF-16 units,
    // 4 UTF-8 bytes) both stress the contract.
    //
    // Real prod row 856ea54d: "Historically, the modern project of food..."
    // with one U+2019 in "Jesus's". Without this fix, totalLength check
    // fails (264 UTF-16 units vs 266 styles sum), renderStyledText falls
    // back to a single regular run, no italic span emitted in DOM.
    const text = "ab’cd"; // 5 codepoints, 5 UTF-16 units, 7 UTF-8 bytes
    const runs = renderStyledText(text, "R2I2R1");
    expect(runs).toEqual([
      { text: "ab", bold: false, italic: false },
      { text: "’c", bold: false, italic: true },
      { text: "d", bold: false, italic: false },
    ]);
  });

  it("handles astral codepoints (surrogate pairs) as one codepoint each", () => {
    // U+1F600 (😀) is 1 codepoint, 2 UTF-16 units, 4 UTF-8 bytes.
    // Without codepoint iteration, .length would report 4 here and
    // slice() would split the surrogate pair mid-character.
    const text = "a\u{1F600}b"; // 3 codepoints
    const runs = renderStyledText(text, "R1I1R1");
    expect(runs).toEqual([
      { text: "a", bold: false, italic: false },
      { text: "\u{1F600}", bold: false, italic: true },
      { text: "b", bold: false, italic: false },
    ]);
  });
});
