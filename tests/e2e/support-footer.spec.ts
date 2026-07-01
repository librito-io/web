import { test, expect } from "@playwright/test";
import { awaitHydration } from "./helpers/hydrate";

test.describe("support page", () => {
  test("is publicly reachable and shows the contact form + support email", async ({
    page,
  }) => {
    await page.goto("/support");
    await awaitHydration(page);

    await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
    await expect(page.getByLabel("Your email")).toBeVisible();
    await expect(page.getByLabel("How can we help?")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "support@librito.io" }),
    ).toHaveAttribute("href", "mailto:support@librito.io");

    // Honeypot is present but hidden from the accessibility tree. The
    // layout's footer also renders on /support (showFooter is true here)
    // and carries its own `input[name="company"]` newsletter honeypot, so
    // this must scope to the contact form specifically or the count
    // assertion below sees 2 matches instead of 1.
    const hp = page.locator('form[action="?/contact"] input[name="company"]');
    await expect(hp).toHaveCount(1);
    await expect(hp).toHaveAttribute("aria-hidden", "true");
  });
});

test.describe("footer", () => {
  test("renders on the landing page with newsletter + links", async ({
    page,
  }) => {
    await page.goto("/");
    await awaitHydration(page);

    const footer = page.getByRole("contentinfo");
    await expect(footer).toBeVisible();
    await expect(footer.getByPlaceholder("Email address")).toBeVisible();
    await expect(
      footer.getByRole("link", { name: "Support", exact: true }),
    ).toBeVisible();
    await expect(
      footer.getByRole("link", { name: "Privacy", exact: true }),
    ).toBeVisible();
  });

  test("is absent on auth routes", async ({ page }) => {
    await page.goto("/auth/login");
    await awaitHydration(page);
    await expect(page.getByRole("contentinfo")).toHaveCount(0);
    await expect(page.getByPlaceholder("Email address")).toHaveCount(0);
  });
});
