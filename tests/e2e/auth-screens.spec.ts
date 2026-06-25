import { test, expect } from "@playwright/test";
import { awaitHydration } from "./helpers/hydrate";

test.describe("auth screens", () => {
  test("login shows both OAuth buttons and the email form", async ({
    page,
  }) => {
    await page.goto("/auth/login");
    await awaitHydration(page);
    await expect(page.getByRole("button", { name: "Google" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Apple" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  });

  test("password field reveal toggle flips type and is non-submitting", async ({
    page,
  }) => {
    await page.goto("/auth/login");
    await awaitHydration(page);

    const pw = page.getByLabel("Password", { exact: true });
    await expect(pw).toHaveAttribute("type", "password");

    const show = page.getByRole("button", { name: "Show password" });
    await expect(show).toBeVisible();
    // type="button" so toggling never submits the login form.
    await expect(show).toHaveAttribute("type", "button");
    await expect(show).toHaveAttribute("aria-pressed", "false");

    // Focus the field, then toggle: focus must stay on the input so the field
    // border + Safari keychain popover don't flash on click (mousedown
    // preventDefault on the toggle). Assert the input is still activeElement.
    await pw.focus();
    await show.click();
    await expect(pw).toHaveAttribute("type", "text");
    expect(await pw.evaluate((el) => el === document.activeElement)).toBe(true);

    const hide = page.getByRole("button", { name: "Hide password" });
    await expect(hide).toHaveAttribute("aria-pressed", "true");

    await hide.click();
    await expect(pw).toHaveAttribute("type", "password");
    expect(await pw.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test("verify-email renders a 6-digit code field with the right input shape", async ({
    page,
  }) => {
    await page.goto("/auth/verify-email?email=test%40example.com");
    await awaitHydration(page);
    const code = page.getByLabel("6-digit code");
    await expect(code).toBeVisible();
    await expect(code).toHaveAttribute("maxlength", "6");
    await expect(code).toHaveAttribute("inputmode", "numeric");
    // Verify button disabled until 6 digits entered.
    await expect(page.getByRole("button", { name: "Verify" })).toBeDisabled();
    await code.fill("123456");
    await expect(page.getByRole("button", { name: "Verify" })).toBeEnabled();
  });
});
