import { test, expect } from "@playwright/test";
import { awaitHydration } from "./helpers/hydrate";

// Regression guard for the pre-launch launch gate (commit 6e6873e). With
// PUBLIC_LAUNCHED unset — the default in CI and local dev — two cosmetic
// UI gates must hold:
//   - signup +page.svelte `{#if launched}`: /auth/signup shows the
//     "not open yet" notice, NOT the signup form.
//   - +layout.svelte `{#if !launched}`: every page emits
//     <meta name="robots" content="noindex">.
// An inverted condition on either is a silent regression — an exposed
// signup form or an indexed pre-launch site. The paired /robots.txt route
// is covered by tests/routes/robots.test.ts; this guards the two UI gates,
// the same defect class the route test catches. Both assertions read
// SSR output, so they fail loudly if a `!` is dropped or `{#if launched}`
// flipped. Branch-review followup (branch-review.6ytnMK, missing-test-coverage).
test.describe("pre-launch launch gate (PUBLIC_LAUNCHED unset)", () => {
  test("signup shows closed notice, hides form, page is noindex", async ({
    page,
  }) => {
    await page.goto("/auth/signup");
    await awaitHydration(page);

    // signup gate: the closed notice renders, the form does not.
    await expect(page.getByText(/open for sign-?ups yet/i)).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

    // existing users can still reach login regardless of the gate. Scope to
    // the page-body link ("Already have an account? Log in") — the header now
    // also carries a "Log in" link for logged-out visitors (issue #553), so an
    // unscoped getByRole would trip a strict-mode ambiguity on two matches.
    await expect(
      page
        .locator("p")
        .filter({ hasText: /already have an account/i })
        .getByRole("link", { name: /log in/i }),
    ).toBeVisible();

    // noindex gate: the robots meta is present pre-launch.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
  });
});
