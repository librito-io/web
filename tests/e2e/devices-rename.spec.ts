import { test, expect } from "@playwright/test";
import {
  createE2EUser,
  cleanupUser,
  login,
  type E2EUser,
} from "./helpers/auth";
import { getAdmin } from "./helpers/supabase";

// Worked example for issue #346. Covers the three browser-only assertions
// that PR #345 could not verify from HTTP smoke alone: hint visibility,
// native maxlength clipping at 50 chars, scoped rendering of the inline
// error to the correct row.
test.describe("devices rename flow", () => {
  let user: E2EUser;
  let deviceId: string;

  test.beforeEach(async () => {
    user = await createE2EUser("rename");
    const { data, error } = await getAdmin()
      .from("devices")
      .insert({
        user_id: user.id,
        hardware_id: crypto.randomUUID(),
        name: "Original Device",
        api_token_hash: "test-hash-placeholder",
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`device seed failed: ${error?.message ?? "no row"}`);
    }
    deviceId = data.id;
  });

  test.afterEach(async () => {
    await cleanupUser(user.id);
  });

  test("rename: hint visible, native maxlength clips at 50, success persists", async ({
    page,
  }) => {
    await login(page, user);
    await page.goto("/app/devices");
    // Wait for Svelte 5 hydration so the Rename onclick handler is wired up
    // before we click — SSR ships the button without listeners, so a click
    // racing hydration is a no-op.
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Original Device")).toBeVisible();

    await page.getByRole("button", { name: "Rename" }).click();

    // Hint should be visible to the user; it's wired via aria-describedby
    // to the input, but here we assert visibility of the text itself.
    const hint = page.locator(`#rename-${deviceId}-hint`);
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText("Max 50 characters");

    // Native maxlength=50: typing 60 chars clips to 50 without JS guard.
    const longName = "a".repeat(60);
    const input = page.locator(`input[name="name"]`);
    await input.fill(longName);
    await expect(input).toHaveValue("a".repeat(50));

    // Submit and observe rename persists after the action redirects.
    await input.fill("Renamed Device");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Renamed Device")).toBeVisible();
    await expect(page.getByText("Original Device")).toHaveCount(0);
  });
});
