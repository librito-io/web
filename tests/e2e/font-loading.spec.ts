import { test, expect, type Request } from "@playwright/test";
import {
  createE2EUser,
  cleanupUser,
  login,
  type E2EUser,
} from "./helpers/auth";
import { awaitHydration } from "./helpers/hydrate";

// Regression guard for the Inter font swap (PR #417). Asserts the four
// font-loading invariants the swap relies on:
//
//   1. Preload set on /            — Inter 400/600/700, Bitter 500,
//                                    JetBrains 500. No Noto preload.
//   2. Per-script Noto subsets     — non-Latin locales (ar/hi/ja/ko/zh)
//                                    fetch the matching woff2 on-demand
//                                    via fontsource @font-face
//                                    unicode-range.
//   3. Inter Cyrillic on-demand    — ru locale fetches inter-cyrillic
//                                    woff2 via @fontsource/inter/500.css.
//   4. Real Bold, not synthetic    — header h1 resolves to Inter 700
//                                    (document.fonts.check).
//
// FOUT on cold cache for non-Latin locales is not asserted — locale-gated
// preload to eliminate it tracked in issue #416.

test.describe("font loading", () => {
  test("preload links: Inter + Bitter + JetBrains, no Noto", async ({
    page,
  }) => {
    await page.goto("/");
    await awaitHydration(page);

    const preloads = await page
      .locator('link[rel="preload"][as="font"]')
      .evaluateAll((links) =>
        links.map((l) => (l as HTMLLinkElement).getAttribute("href") ?? ""),
      );

    expect(preloads).toEqual(
      expect.arrayContaining([
        "/fonts/inter-400.woff2",
        "/fonts/inter-600.woff2",
        "/fonts/inter-700.woff2",
        "/fonts/bitter-500.woff2",
        "/fonts/jetbrains-mono-500.woff2",
      ]),
    );

    const notoPreloads = preloads.filter((href) => /noto/i.test(href));
    expect(notoPreloads).toEqual([]);
  });

  test("header h1 renders Inter 700, not synthetic bold", async ({ page }) => {
    const user = await createE2EUser("font-bold");
    try {
      await login(page, user);
      await page.waitForFunction(() => document.fonts.ready.then(() => true));

      const computedWeight = await page
        .locator("header h1")
        .first()
        .evaluate((el) => getComputedStyle(el).fontWeight);
      expect(computedWeight).toBe("700");

      // document.fonts.check returns true only if a real face matching
      // the weight is loaded. Synthetic bold (faked off 600) returns
      // false here — the precise regression class this assertion guards.
      const real700 = await page.evaluate(() =>
        document.fonts.check('700 1em "Inter"'),
      );
      expect(real700).toBe(true);
    } finally {
      await cleanupUser(user.id);
    }
  });

  // Per-locale assertion: switching to a non-Latin locale must trigger
  // the matching Noto subset woff2 fetch. fontsource's @font-face
  // unicode-range gating means the browser only fetches when a glyph in
  // that range renders — so the test re-navigates *after* setting
  // localStorage to force the i18n init to pick up the new locale and
  // render the translated strings.
  type Case = { locale: string; pattern: RegExp; label: string };
  // fontsource ships Arabic/Devanagari as named subsets
  // (`noto-sans-arabic-arabic-*.woff2`); CJK packages ship as numeric
  // subset files (`noto-sans-jp-117-*.woff2`) — there is no
  // `japanese`/`korean`/`chinese-simplified` literal in the URL. Match
  // on package name only.
  const cases: Case[] = [
    { locale: "ar", pattern: /noto-sans-arabic[^/]*\.woff2/, label: "ar" },
    {
      locale: "hi",
      pattern: /noto-sans-devanagari[^/]*\.woff2/,
      label: "hi",
    },
    { locale: "ja", pattern: /noto-sans-jp[^/]*\.woff2/, label: "ja" },
    { locale: "ko", pattern: /noto-sans-kr[^/]*\.woff2/, label: "ko" },
    { locale: "zh", pattern: /noto-sans-sc[^/]*\.woff2/, label: "zh" },
  ];

  for (const c of cases) {
    test(`locale=${c.label} fetches matching Noto subset on-demand`, async ({
      page,
    }) => {
      const user = await createE2EUser(`font-${c.label}`);
      try {
        await login(page, user);

        const fontRequests: string[] = [];
        const collect = (req: Request): void => {
          if (req.resourceType() === "font") fontRequests.push(req.url());
        };
        page.on("request", collect);

        await page.evaluate(
          (loc) => localStorage.setItem("librito.locale", loc),
          c.locale,
        );
        await page.reload();
        await awaitHydration(page);
        await page.waitForFunction(() => document.fonts.ready.then(() => true));

        page.off("request", collect);

        const noNotoPreload = await page
          .locator('link[rel="preload"][as="font"]')
          .evaluateAll((links) =>
            links
              .map((l) => (l as HTMLLinkElement).getAttribute("href") ?? "")
              .filter((h) => /noto/i.test(h)),
          );
        expect(noNotoPreload).toEqual([]);

        const matched = fontRequests.filter((url) => c.pattern.test(url));
        expect(
          matched,
          `expected at least one ${c.label} Noto subset fetch, got: ${fontRequests.join(", ")}`,
        ).not.toEqual([]);
      } finally {
        await cleanupUser(user.id);
      }
    });
  }

  test("locale=ru fetches Inter Cyrillic on-demand, not preload", async ({
    page,
  }) => {
    const user = await createE2EUser("font-ru");
    try {
      await login(page, user);

      const fontRequests: string[] = [];
      const collect = (req: Request): void => {
        if (req.resourceType() === "font") fontRequests.push(req.url());
      };
      page.on("request", collect);

      await page.evaluate(() => localStorage.setItem("librito.locale", "ru"));
      await page.reload();
      await awaitHydration(page);
      await page.waitForFunction(() => document.fonts.ready.then(() => true));

      page.off("request", collect);

      const cyrillic = fontRequests.filter((u) =>
        /inter-cyrillic.*\.woff2/.test(u),
      );
      expect(
        cyrillic,
        `expected Inter Cyrillic subset fetch, got: ${fontRequests.join(", ")}`,
      ).not.toEqual([]);
    } finally {
      await cleanupUser(user.id);
    }
  });
});
