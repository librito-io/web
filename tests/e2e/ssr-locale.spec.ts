import { test, expect } from "@playwright/test";
import { awaitHydration } from "./helpers/hydrate";

// SSR locale resolution (issue #523). localeSetup (hooks.server.ts)
// resolves cookie → Accept-Language → "en", rewrites the <html> open
// tag, and the root layout load inits svelte-i18n with the same locale
// so SSR text matches. The request-fixture tests assert on raw response
// HTML — the contract must hold before any JS runs. Issue #553 gated the
// hamburger (and its menuLabel aria-label) behind auth, so the header's
// Log-in link text (navLogIn) is now the translated string SSR'd on the
// logged-out `/`, and serves as the rendered-strings probe.
test.describe("SSR locale resolution", () => {
  test("locale cookie drives SSR lang and strings", async ({ request }) => {
    const res = await request.get("/", {
      headers: { cookie: "librito.locale=ja" },
    });
    const html = await res.text();
    expect(html).toContain('<html lang="ja" dir="ltr">');
    expect(html).toContain("ログイン");
  });

  test("Arabic cookie flips dir to rtl at SSR", async ({ request }) => {
    const res = await request.get("/", {
      headers: { cookie: "librito.locale=ar" },
    });
    expect(await res.text()).toContain('<html lang="ar" dir="rtl">');
  });

  test("Accept-Language drives SSR when no cookie", async ({ request }) => {
    const res = await request.get("/", {
      headers: { "accept-language": "de-DE,de;q=0.9,en;q=0.5" },
    });
    const html = await res.text();
    expect(html).toContain('<html lang="de" dir="ltr">');
    expect(html).toContain("Anmelden");
  });

  test("unsupported cookie falls back to Accept-Language", async ({
    request,
  }) => {
    const res = await request.get("/", {
      headers: { cookie: "librito.locale=klingon", "accept-language": "ko" },
    });
    expect(await res.text()).toContain('<html lang="ko" dir="ltr">');
  });

  test("unsupported Accept-Language falls back to English", async ({
    request,
  }) => {
    const res = await request.get("/", {
      headers: { "accept-language": "xx-YY" },
    });
    const html = await res.text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain("Log in");
  });
});

test.describe("locale cookie lifecycle", () => {
  test("language pick writes the cookie and survives reload", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await awaitHydration(page);

    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("button", { name: "日本語" }).click();

    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === "librito.locale")?.value).toBe("ja");

    await page.reload();
    await awaitHydration(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByRole("link", { name: "ログイン" })).toBeVisible();
  });

  test("legacy localStorage-only locale migrates to a cookie", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await awaitHydration(page);

    // Pre-#523 client state: stored locale, no cookie.
    await context.clearCookies();
    await page.evaluate(() => localStorage.setItem("librito.locale", "hi"));

    await page.reload();
    await awaitHydration(page);

    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === "librito.locale")?.value).toBe("hi");
    // The stored choice is honored this load (hydration repaint), not
    // just persisted for the next one.
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  });
});
