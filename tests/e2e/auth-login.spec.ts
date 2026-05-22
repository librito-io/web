import { test, expect } from "@playwright/test";
import {
  createE2EUser,
  cleanupUser,
  login,
  type E2EUser,
} from "./helpers/auth";

// Regression guard for issue #363: the login helper must surface the
// inline auth-error text in the thrown error instead of hanging to a
// generic waitForURL timeout. Without this race a credentials regression
// looks like a flake until someone re-runs with a trace and inspects the
// DOM.
test.describe("login helper", () => {
  let user: E2EUser;

  test.beforeEach(async () => {
    user = await createE2EUser("login-helper");
  });

  test.afterEach(async () => {
    await cleanupUser(user.id);
  });

  test("rejects with inline-error text on bad password", async ({ page }) => {
    const badUser: E2EUser = {
      id: user.id,
      email: user.email,
      password: "definitely-not-the-right-password",
    };

    await expect(login(page, badUser)).rejects.toThrow(/login failed:/);
  });
});
