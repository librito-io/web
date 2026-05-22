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

  test.beforeEach(async () => {
    user = await createE2EUser("rename");
  });

  test.afterEach(async () => {
    await cleanupUser(user.id);
  });

  async function seedDevice(name: string): Promise<string> {
    const { data, error } = await getAdmin()
      .from("devices")
      .insert({
        user_id: user.id,
        hardware_id: crypto.randomUUID(),
        name,
        api_token_hash: crypto.randomUUID(),
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`device seed failed: ${error?.message ?? "no row"}`);
    }
    return data.id;
  }

  test("rename: hint visible, native maxlength clips at 50, success persists", async ({
    page,
  }) => {
    const deviceId = await seedDevice("Original Device");

    await login(page, user);
    await page.goto("/app/devices");
    // Wait for Svelte 5 hydration so the Rename onclick handler is wired up
    // before we click — SSR ships the button without listeners, so a click
    // racing hydration is a no-op.
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText("Original Device", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Rename" }).click();

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
    await expect(
      page.getByText("Renamed Device", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Original Device", { exact: true }),
    ).toHaveCount(0);
  });

  test("rename error renders only under the submitting device's form", async ({
    page,
  }) => {
    // Two-device fixture exercises the scope guard at +page.svelte:113
    // (`form.deviceId === device.id`). HTTP-level smoke cannot observe this
    // — the regression class is "error leaks across rows" which only shows
    // up in the rendered DOM.
    const deviceAId = await seedDevice("Device Alpha");
    const deviceBId = await seedDevice("Device Bravo");

    await login(page, user);
    await page.goto("/app/devices");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Device Alpha", { exact: true })).toBeVisible();
    await expect(page.getByText("Device Bravo", { exact: true })).toBeVisible();

    const deviceA = page.locator(`li:has(input[value="${deviceAId}"])`);
    const deviceB = page.locator(`li:has(input[value="${deviceBId}"])`);

    // Open rename on A only, bypass the native maxlength=50 so a 51-char
    // submit reaches the server validator (returns fail with action=rename,
    // deviceId=A) and the inline error renders.
    await deviceA.getByRole("button", { name: "Rename" }).click();
    const inputA = deviceA.locator('input[name="name"]');
    await inputA.evaluate((el) => el.removeAttribute("maxlength"));
    await inputA.fill("a".repeat(51));
    await deviceA.getByRole("button", { name: "Save" }).click();

    // Error visible under A's row.
    const errorText = "Name must be 50 characters or less";
    await expect(deviceA.getByText(errorText)).toBeVisible();

    // Bug class: error leaking across rows. B is in display mode (no form
    // open) — the error must not surface under its <li>.
    await expect(deviceB.getByText(errorText)).toHaveCount(0);

    // Stronger guard: cancel A's rename, open B's rename. With the bug,
    // the page-wide `form` prop with deviceId=A would still match if the
    // template's scope check regressed. Assert B's freshly-opened form is
    // error-free.
    await deviceA.getByRole("button", { name: "Cancel" }).click();
    await deviceB.getByRole("button", { name: "Rename" }).click();
    await expect(deviceB.locator(`#rename-${deviceBId}-hint`)).toBeVisible();
    await expect(deviceB.getByText(errorText)).toHaveCount(0);
  });
});
