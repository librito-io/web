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
