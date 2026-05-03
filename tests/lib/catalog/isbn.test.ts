import { describe, it, expect } from "vitest";
import {
  canonicalizeIsbn,
  isbn10To13,
} from "../../../src/lib/server/catalog/isbn";

describe("canonicalizeIsbn", () => {
  it("returns null for empty / non-digit / too-short input", () => {
    expect(canonicalizeIsbn("")).toBeNull();
    expect(canonicalizeIsbn("abcdef")).toBeNull();
    expect(canonicalizeIsbn("12345")).toBeNull();
  });

  it("validates and returns ISBN-13 input unchanged", () => {
    expect(canonicalizeIsbn("9780306406157")).toBe("9780306406157");
    expect(canonicalizeIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(canonicalizeIsbn(" 978 0 306 40615 7 ")).toBe("9780306406157");
  });

  it("rejects ISBN-13 with bad checksum", () => {
    expect(canonicalizeIsbn("9780306406150")).toBeNull();
  });

  it("converts ISBN-10 (digits) to ISBN-13", () => {
    expect(canonicalizeIsbn("0306406152")).toBe("9780306406157");
  });

  it("converts ISBN-10 with X check digit", () => {
    // 0-8044-2957-X → 978-0-8044-2957-9
    expect(canonicalizeIsbn("080442957X")).toBe("9780804429573");
  });

  it("rejects ISBN-10 with bad checksum", () => {
    expect(canonicalizeIsbn("0306406151")).toBeNull();
  });
});

describe("isbn10To13", () => {
  it("prepends 978 and recomputes the EAN-13 check digit", () => {
    expect(isbn10To13("0306406152")).toBe("9780306406157");
  });
  it("returns null on bad input", () => {
    expect(isbn10To13("12345")).toBeNull();
  });
});
