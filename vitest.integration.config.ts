import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integration suite: boots against a running local Supabase (port 54322).
// Gated by INTEGRATION=1 so it never runs in the default unit suite.
// Serial-only because all tests share one Postgres instance.
//
// `$lib` alias is duplicated here rather than imported from
// `vite.config.ts` because the latter loads the SvelteKit + Sentry
// plugins, which fight the integration runner's pure-Node setup.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
