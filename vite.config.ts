import { sveltekit } from "@sveltejs/kit/vite";
import { sentrySvelteKit } from "@sentry/sveltekit";
import { defineConfig } from "vitest/config";

// Mirror Vercel-provided server-side env vars into PUBLIC_*-prefixed
// equivalents so SvelteKit's $env/dynamic/public publishes them to the
// browser bundle. Read by src/hooks.client.ts for Sentry's environment
// + release tags. Build-time mirror only — no runtime overhead.
//
// Rejected alternative: vercel.ts `env: { ... }` block. @vercel/config v1
// marks that field as @deprecated. The vite.config.ts mirror is the
// supported mechanism; runs at build time before SvelteKit reads its
// $env/* modules.
if (process.env.VERCEL_GIT_COMMIT_SHA) {
  process.env.PUBLIC_VERCEL_GIT_COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA;
}
if (process.env.VERCEL_ENV) {
  process.env.PUBLIC_VERCEL_ENV = process.env.VERCEL_ENV;
}

export default defineConfig({
  plugins: [
    // Order matters: sentrySvelteKit must precede sveltekit() per Sentry's
    // SvelteKit integration docs. Source-map upload runs only when all three
    // env vars below are set; absent any of them, the plugin warns then
    // skips upload and the build still succeeds (preserved behaviour for
    // self-hosters + local dev).
    sentrySvelteKit({
      sourceMapsUploadOptions: {
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
      },
    }),
    sveltekit(),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
  },
});
