import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "./helpers/auth";
import { awaitHydration } from "./helpers/hydrate";

// Issue #553: logged-out visitors must not see app chrome. The overlay menu
// (hamburger → Highlight Manager / Book Transfer / Devices / Log out) leaks
// the product's structure pre-launch, so the hamburger + overlay are gated on
// auth. A "Log in" link takes the hamburger's place in the header right-slot
// so existing users still have a way in. Logged-in users see the hamburger as
// before, and no Log-in link (its inverse).
//
// The link is keyed on its stable href, not its visible text: the text is
// localized (navLogIn) and locale-dependent, and the login *page* also renders
// a "Log in" form button — keying on `header a[href="/auth/login"]` avoids both
// the locale coupling and the role collision. ssr-locale.spec.ts covers the
// translated rendering of the link text.
test.describe("header auth chrome gating", () => {
  test("logged-out: no overlay menu, a Log-in link that reaches login", async ({
    page,
  }) => {
    await page.goto("/");
    await awaitHydration(page);

    // No app chrome leaks to anonymous visitors.
    await expect(page.locator("button.menu-btn")).toHaveCount(0);
    await expect(page.locator("#menuOverlay")).toHaveCount(0);

    // The Log-in link stands in for the hamburger and reaches the login page.
    const loginLink = page.locator('header a[href="/auth/login"]');
    await expect(loginLink).toBeVisible();
    await loginLink.click();
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test("logged-in: hamburger present, no Log-in link", async ({ page }) => {
    const user = await createE2EUser("header-chrome");
    try {
      await login(page, user); // lands under /app
      await awaitHydration(page);

      await expect(page.locator("button.menu-btn")).toBeVisible();
      await expect(page.locator('header a[href="/auth/login"]')).toHaveCount(0);
    } finally {
      await cleanupUser(user.id);
    }
  });
});
