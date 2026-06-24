import { test, expect } from "@playwright/test";
import { awaitHydration } from "./helpers/hydrate";

test.describe("auth screens", () => {
  test("login shows both OAuth buttons and the email form", async ({
    page,
  }) => {
    await page.goto("/auth/login");
    await awaitHydration(page);
    await expect(
      page.getByRole("button", { name: "Continue with Google" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with Apple" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
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
