import { describe, it, expect } from "vitest";
import { resolveLocale } from "../../src/lib/i18n/resolve";

// Server-side locale resolution: cookie wins, else Accept-Language
// (q-ordered, prefix-matched against SUPPORTED_LOCALES), else "en".
describe("resolveLocale", () => {
  it("prefers a valid cookie over the Accept-Language header", () => {
    expect(resolveLocale("ja", "de-DE,de;q=0.9")).toBe("ja");
  });

  it("ignores an unsupported cookie value and falls back to the header", () => {
    expect(resolveLocale("klingon", "ko-KR,ko;q=0.9")).toBe("ko");
  });

  it("orders header candidates by q-value, not position", () => {
    expect(resolveLocale(null, "fr;q=0.8,de;q=0.9")).toBe("de");
  });

  it("matches region-qualified tags by primary subtag", () => {
    expect(resolveLocale(null, "pt-BR,en;q=0.5")).toBe("pt");
  });

  it("keeps header order for equal q-values", () => {
    expect(resolveLocale(null, "de,fr")).toBe("de");
  });

  it("treats a missing q as 1.0", () => {
    expect(resolveLocale(null, "es;q=0.7,it")).toBe("it");
  });

  it("skips unsupported tags and takes the next supported one", () => {
    expect(resolveLocale(null, "xx-YY,ja;q=0.8")).toBe("ja");
  });

  it("ignores wildcard entries", () => {
    expect(resolveLocale(null, "*,ko;q=0.9")).toBe("ko");
  });

  it("is case-insensitive on header tags", () => {
    expect(resolveLocale(null, "JA-JP")).toBe("ja");
  });

  it("tolerates whitespace around entries", () => {
    expect(resolveLocale(null, " de , fr;q=0.9 ")).toBe("de");
  });

  it("never selects a q=0 entry (RFC 7231: not acceptable)", () => {
    expect(resolveLocale(null, "de;q=0")).toBe("en");
    expect(resolveLocale(null, "de;q=0,fr;q=0.5")).toBe("fr");
  });

  it("clamps out-of-range q so it cannot outrank legitimate entries", () => {
    expect(resolveLocale(null, "de;q=5,fr")).toBe("de");
    expect(resolveLocale(null, "fr,de;q=5")).toBe("fr");
  });

  it("returns 'en' when nothing in the header is supported", () => {
    expect(resolveLocale(null, "xx,zz;q=0.5")).toBe("en");
  });

  it("returns 'en' for null cookie and null header", () => {
    expect(resolveLocale(null, null)).toBe("en");
  });

  it("returns 'en' for an empty header", () => {
    expect(resolveLocale(null, "")).toBe("en");
  });

  it("returns 'en' for a garbage header without crashing", () => {
    expect(resolveLocale(null, ";;;,,q=,")).toBe("en");
  });
});
