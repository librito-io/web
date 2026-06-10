import { vi } from "vitest";
vi.mock("$app/environment", () => ({ browser: false }));

import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { initI18n, locale } from "../../src/lib/i18n/index";

// svelte-i18n state is module-global, so these tests share one instance
// and run order matters — exactly the condition initI18n must handle on
// the server, where one warm instance serves many requests (issue #523).
// The $locale store settles only after the locale's json loader resolves;
// initI18n's contract is that awaiting it means the locale is applied
// (argless waitLocale() can't do this — it flushes the OLD locale's
// queue when a set() is still pending).
describe("initI18n", () => {
  it("initializes svelte-i18n with the given locale", async () => {
    await initI18n("ja");
    expect(get(locale)).toBe("ja");
  });

  it("updates the locale on later calls instead of keeping the first one", async () => {
    await initI18n("ja");
    await initI18n("de");
    expect(get(locale)).toBe("de");
  });
});
