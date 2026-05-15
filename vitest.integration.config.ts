import { defineConfig } from "vitest/config";

// Integration suite: boots against a running local Supabase (port 54322).
// Gated by INTEGRATION=1 so it never runs in the default unit suite.
// Serial-only because all tests share one Postgres instance.
export default defineConfig({
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
