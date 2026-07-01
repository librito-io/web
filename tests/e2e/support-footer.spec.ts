import { test, expect } from "@playwright/test";
import { awaitHydration } from "./helpers/hydrate";

test.describe("support page", () => {
  test("is publicly reachable and shows the contact form + support email", async ({
    page,
  }) => {
    await page.goto("/support");
    await awaitHydration(page);

    await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
    await expect(page.getByLabel("Your email address")).toBeVisible();
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

test.describe("footer newsletter subscribe", () => {
  test("success toggle: shows success message and clears the email input", async ({
    page,
  }) => {
    await page.goto("/");
    await awaitHydration(page);

    const footer = page.getByRole("contentinfo");
    const emailInput = footer.getByPlaceholder("Email address");
    const submit = footer.getByRole("button", {
      name: "Subscribe to the newsletter",
    });

    const requestPromise = page.waitForRequest("**/api/newsletter");
    await page.route("**/api/newsletter", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ subscribed: true }),
      }),
    );

    await emailInput.fill("reader@example.com");
    await submit.click();

    const request = await requestPromise;
    const body = request.postDataJSON();
    expect(body.email).toBe("reader@example.com");
    expect(typeof body.locale).toBe("string");
    expect(body.company).toBe("");

    await expect(footer.getByText("You're on the list.")).toBeVisible();
    await expect(emailInput).toHaveCount(0);
  });

  test("error toggle: shows the error message on a failed response", async ({
    page,
  }) => {
    await page.goto("/");
    await awaitHydration(page);

    const footer = page.getByRole("contentinfo");
    const emailInput = footer.getByPlaceholder("Email address");
    const submit = footer.getByRole("button", {
      name: "Subscribe to the newsletter",
    });

    await page.route("**/api/newsletter", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "server_error" }),
      }),
    );

    await emailInput.fill("reader@example.com");
    await submit.click();

    await expect(
      footer.getByText("Couldn't sign you up. Try again."),
    ).toBeVisible();
  });
});
