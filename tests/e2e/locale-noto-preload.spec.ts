import { test, expect } from "@playwright/test";
import { awaitHydration } from "./helpers/hydrate";

// Locale-gated Noto preload (issue #416). With the locale server-resolved
// from the librito.locale cookie (#523), the root layout emits a
// <link rel="preload"> for the matching self-hosted Noto subset only on
// ar/hi, and nothing on every other locale. Raw-HTML assertions use the
// request fixture so the contract is checked before any JS runs.

function notoPreloads(html: string): string[] {
  return [...html.matchAll(/<link[^>]+rel="preload"[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /as="font"/.test(tag) && /noto/i.test(tag))
    .map((tag) => tag.match(/href="([^"]+)"/)?.[1] ?? "");
}

test.describe("locale-gated Noto preload", () => {
  test("ar preloads the Arabic 400 + 600 subsets", async ({ request }) => {
    const html = await (
      await request.get("/", { headers: { cookie: "librito.locale=ar" } })
    ).text();
    expect(notoPreloads(html).sort()).toEqual([
      "/fonts/noto-sans-arabic-400.woff2",
      "/fonts/noto-sans-arabic-600.woff2",
    ]);
  });

  test("hi preloads the Devanagari 400 + 600 subsets", async ({ request }) => {
    const html = await (
      await request.get("/", { headers: { cookie: "librito.locale=hi" } })
    ).text();
    expect(notoPreloads(html).sort()).toEqual([
      "/fonts/noto-sans-devanagari-400.woff2",
      "/fonts/noto-sans-devanagari-600.woff2",
    ]);
  });

  for (const locale of ["en", "de", "ru", "ja", "ko", "zh"]) {
    test(`${locale} emits no Noto preload`, async ({ request }) => {
      const html = await (
        await request.get("/", {
          headers: { cookie: `librito.locale=${locale}` },
        })
      ).text();
      expect(notoPreloads(html)).toEqual([]);
    });
  }

  test("preloaded Arabic woff2 registers a real face and loads", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "librito.locale", value: "ar", url: baseURL! },
    ]);
    await page.goto("/");
    await awaitHydration(page);

    // Two-part guard mirroring the Literata/InterVariable pattern in
    // font-loading.spec.ts: a registered @font-face (not synthetic
    // fallback) AND a successful woff2 fetch.
    const arabicFaces = await page.evaluate(() => {
      const out: { weight: string }[] = [];
      for (const face of document.fonts) {
        if (face.family.replace(/['"]/g, "") === "Noto Sans Arabic") {
          out.push({ weight: face.weight });
        }
      }
      return out;
    });
    expect(arabicFaces.some((f) => f.weight === "400")).toBe(true);
    expect(arabicFaces.some((f) => f.weight === "600")).toBe(true);

    const loaded = await page.evaluate(async () => {
      // U+0627 ARABIC LETTER ALEF — inside the self-hosted subset range.
      const faces = await document.fonts.load(
        '400 1em "Noto Sans Arabic"',
        "ا",
      );
      return faces.length;
    });
    expect(loaded).toBeGreaterThan(0);
  });
});

// Glyph-accurate "what actually painted" check via the Chrome DevTools
// Protocol (CSS.getPlatformFontsForNode). Stronger than document.fonts
// above: that proves the face is loadable, this proves the rendered
// glyphs were drawn with it — catching a broken cascade / unicode-range
// / missing-preload that leaves the face loaded but unused at paint
// (font-display: optional renders the fallback for the whole load if it
// misses the window). CHROMIUM-ONLY: getPlatformFontsForNode is a CDP
// surface WebKit/Safari doesn't expose, so this does not replicate
// Safari's stricter optional timing — it guards the font-selection
// wiring in the Chromium CI lane. NOTE: Safari's element Font panel
// reports the primary family name (Inter), not the per-glyph fallback
// face, so it is NOT a valid manual substitute for this check.
test.describe("rendered Noto face (CDP, Chromium-only)", () => {
  async function renderedFamily(
    page: import("@playwright/test").Page,
    selector: string,
  ): Promise<string> {
    const client = await page.context().newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = (await client.send("DOM.getDocument")) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await client.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    })) as { nodeId: number };
    expect(nodeId, `node not found: ${selector}`).toBeTruthy();
    const { fonts } = (await client.send("CSS.getPlatformFontsForNode", {
      nodeId,
    })) as { fonts: { familyName: string; isCustomFont: boolean }[] };
    expect(fonts.length, `no rendered font for ${selector}`).toBeGreaterThan(0);
    // The dominant face drawing the node's glyphs.
    return fonts[0].familyName;
  }

  // The language dropdown items carry always-Arabic / always-Devanagari
  // visible text (their native names), so they exercise the script
  // fallback regardless of the active UI locale.
  async function openDropdown(
    page: import("@playwright/test").Page,
  ): Promise<void> {
    await page.getByRole("button", { name: "Language" }).click();
    await page.locator('[data-lang="ar"]').waitFor({ state: "visible" });
  }

  test("ar locale paints Arabic glyphs with self-hosted Noto Sans Arabic", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "librito.locale", value: "ar", url: baseURL! },
    ]);
    await page.goto("/");
    await awaitHydration(page);
    await page.waitForFunction(() => document.fonts.ready.then(() => true));
    await openDropdown(page);

    // familyName carries the subfamily suffix (e.g. "… SemiBold"); match
    // the family prefix. Inter has no Arabic glyphs, so this only passes
    // if the Noto face actually drew them.
    expect(await renderedFamily(page, '[data-lang="ar"]')).toMatch(
      /^Noto Sans Arabic/,
    );
  });

  test("hi locale paints Devanagari glyphs with self-hosted Noto Sans Devanagari", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "librito.locale", value: "hi", url: baseURL! },
    ]);
    await page.goto("/");
    await awaitHydration(page);
    await page.waitForFunction(() => document.fonts.ready.then(() => true));
    await openDropdown(page);

    expect(await renderedFamily(page, '[data-lang="hi"]')).toMatch(
      /^Noto Sans Devanagari/,
    );
  });

  test("Latin text still paints with Inter, not Noto", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "librito.locale", value: "ar", url: baseURL! },
    ]);
    await page.goto("/");
    await awaitHydration(page);
    await page.waitForFunction(() => document.fonts.ready.then(() => true));

    // Header wordmark is Latin — must route to Inter even with an
    // Arabic locale active, proving the unicode-range scoping keeps the
    // Noto faces off non-script codepoints.
    expect(await renderedFamily(page, "header h1")).toMatch(/^Inter/);
  });
});
