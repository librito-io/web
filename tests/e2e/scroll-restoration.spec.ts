import { test, expect } from "@playwright/test";

// Regression guard for the pre-paint scroll-restore inline script in
// `src/app.html`. SvelteKit forces `history.scrollRestoration = "manual"` and
// re-applies the saved scroll position from its client bundle only AFTER
// hydration begins, so a full reload of a scrolled page paints at scrollY 0
// (top/hero) and then jumps to the saved position — a visible flash of the top
// content over wherever the user was (the reported "hero flashing over the
// footer"). The inline script restores scroll synchronously at end-of-body,
// before first paint and before hydration, reading SvelteKit's own snapshot.
//
// The flash is a hydration-timing race: on a fast machine the client bundle
// wins and the flash is invisible, so a naive "did any frame paint at 0" assert
// would pass even with the fix removed. Instead we STALL the SvelteKit client
// runtime module, which turns the race into a deterministic assertion — with
// hydration blocked, the ONLY thing that can restore scroll before we sample is
// the inline script. Verified to read `target` with the script present and 0
// with it stripped.
test.describe("scroll restoration on reload", () => {
  test("restores scroll before hydration so top content never flashes over the footer", async ({
    page,
  }) => {
    await page.goto("/");
    // Scroll to the footer; SvelteKit persists the position snapshot to
    // sessionStorage (keyed by the history index) on unload.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const target = await page.evaluate(() => Math.round(window.scrollY));
    // The landing page must actually overflow the viewport, or this test would
    // assert nothing (a 0 == 0 pass). Guards against a future layout change
    // that shortens the page and silently defangs the regression check.
    expect(target).toBeGreaterThan(0);

    // Dev serves the runtime as an unbundled module at
    // /node_modules/@sveltejs/kit/src/runtime/client/entry.js. Delaying it
    // stalls hydration for the sampling window below. Path is dev-specific;
    // the e2e suite runs against `npm run dev` (playwright.config webServer).
    await page.route(
      "**/@sveltejs/kit/src/runtime/client/**",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await route.continue();
      },
    );

    await page.reload({ waitUntil: "commit" });
    // Hydration is still blocked by the 2s route delay; only the inline script
    // could have moved the scroll position by now.
    await page.waitForTimeout(400);

    const early = await page.evaluate(() => Math.round(window.scrollY));
    expect(early).toBe(target);
  });
});
