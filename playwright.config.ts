import { defineConfig, devices } from "@playwright/test";

// E2E suite drives a real Chromium against the SvelteKit dev server with a
// running local Supabase. `webServer` autostarts `npm run dev`; the suite
// expects `supabase start` to already be running (helpers shell out to
// `supabase status -o env` to read API URL + keys). CI provisions both.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // CI: pipe so dev-server stdout (vite errors, missing-env crashes,
    // port conflicts) surfaces in the Playwright report when webServer
    // boot fails. Local: ignore to keep the suite quiet for the common
    // case of running against an already-warm dev server. Issue #362.
    stdout: process.env.CI ? "pipe" : "ignore",
    stderr: "pipe",
  },
});
