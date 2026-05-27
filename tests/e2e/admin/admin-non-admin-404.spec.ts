import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";

test("non-admin user gets 404 on /app/admin", async ({ page }) => {
  const user = await createE2EUser("admin-non-admin-404");
  try {
    await login(page, user);
    const resp = await page.goto("/app/admin");
    expect(resp?.status()).toBe(404);
  } finally {
    await cleanupUser(user.id);
  }
});
