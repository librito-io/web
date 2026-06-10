import { describe, it, expect } from "vitest";
import { notoPreloadForLocale } from "../../src/lib/fonts";
import { SUPPORTED_LOCALES } from "../../src/lib/i18n/locales";

// Locale-gated Noto preload (issue #416). Only the two scripts that ship
// a single-file fontsource subset (Arabic, Devanagari) are preloadable;
// every other locale emits nothing so Latin/Cyrillic/CJK cold loads pay
// zero extra bytes.
describe("notoPreloadForLocale", () => {
  it("returns the Arabic 400 + 600 subsets for ar", () => {
    expect(notoPreloadForLocale("ar")).toEqual([
      "/fonts/noto-sans-arabic-400.woff2",
      "/fonts/noto-sans-arabic-600.woff2",
    ]);
  });

  it("returns the Devanagari 400 + 600 subsets for hi", () => {
    expect(notoPreloadForLocale("hi")).toEqual([
      "/fonts/noto-sans-devanagari-400.woff2",
      "/fonts/noto-sans-devanagari-600.woff2",
    ]);
  });

  it("returns nothing for CJK locales (no single-file subset)", () => {
    expect(notoPreloadForLocale("ja")).toEqual([]);
    expect(notoPreloadForLocale("ko")).toEqual([]);
    expect(notoPreloadForLocale("zh")).toEqual([]);
  });

  it("returns nothing for Latin/Cyrillic locales", () => {
    expect(notoPreloadForLocale("en")).toEqual([]);
    expect(notoPreloadForLocale("de")).toEqual([]);
    expect(notoPreloadForLocale("ru")).toEqual([]);
  });

  it("never throws for any supported locale", () => {
    for (const loc of SUPPORTED_LOCALES) {
      expect(() => notoPreloadForLocale(loc)).not.toThrow();
    }
  });

  it("every preload href is also self-hosted (single-fetch invariant)", () => {
    // Both preloadable locales must reference /fonts/ URLs that the
    // @font-face src reuses — same guarantee as PRELOAD_FONTS.
    for (const loc of ["ar", "hi"] as const) {
      for (const href of notoPreloadForLocale(loc)) {
        expect(href).toMatch(/^\/fonts\/noto-sans-[a-z]+-\d{3}\.woff2$/);
      }
    }
  });
});
