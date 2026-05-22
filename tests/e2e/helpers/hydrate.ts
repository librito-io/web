import type { Page } from "@playwright/test";

// Wait for Svelte 5 hydration to complete before driving interactive
// elements. The root layout (`src/routes/+layout.svelte`) sets
// `data-hydrated="true"` on `<html>` from `onMount`, which fires only
// after client-side hydration finishes wiring `onclick` / `onsubmit`
// listeners onto SSR-emitted DOM.
//
// Replaces `page.waitForLoadState("networkidle")`, which Playwright
// documents as a discouraged anti-pattern: a long-lived request
// (Supabase Realtime websocket, SSE, analytics beacon, HMR poll) keeps
// the network non-idle past the 30s default and the test times out
// unrelated to product behaviour. Issue #360.
//
// Default timeout: 10s — generous for cold dev-server first paint, tight
// enough that a regression (layout not mounting, hydration error in the
// console) surfaces as a clear locator timeout instead of a 30s hang.
export async function awaitHydration(
  page: Page,
  options: { timeout?: number } = {},
): Promise<void> {
  await page
    .locator("html[data-hydrated='true']")
    .waitFor({ state: "attached", timeout: options.timeout ?? 10_000 });
}
