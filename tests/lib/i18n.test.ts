import { vi } from "vitest";
vi.mock("$app/environment", () => ({ browser: false }));

import { describe, it, expect } from "vitest";
import { detectLocale } from "../../src/lib/i18n/index";

describe("detectLocale", () => {
  it("prefers stored locale when supported", () => {
    expect(detectLocale("es", "en-US")).toBe("es");
  });
  it("falls back to navigator prefix when no stored locale", () => {
    expect(detectLocale(null, "fr-CA")).toBe("fr");
  });
  it("falls back to 'en' when nothing matches", () => {
    expect(detectLocale(null, "xx-YY")).toBe("en");
  });
  it("ignores stored locale that's not in SUPPORTED_LOCALES", () => {
    expect(detectLocale("klingon", "de-DE")).toBe("de");
  });
  it("lowercases the navigator prefix", () => {
    expect(detectLocale(null, "ZH-Hant")).toBe("zh");
  });
  it("returns 'en' when both inputs are null", () => {
    expect(detectLocale(null, null)).toBe("en");
  });
});
