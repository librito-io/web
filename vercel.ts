// vercel.ts
import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "sveltekit",
  crons: [
    { path: "/api/cron/transfer-sweep", schedule: "0 3 * * *" },
    { path: "/api/cron/catalog-warmup", schedule: "0 8 * * 1" },
    // 09:00 UTC offsets from transfer-sweep (03:00) and catalog-warmup
    // (Mon 08:00). Daily cadence is the natural granularity for catching
    // "started failing in the last week" against the 7-day window in
    // public.pg_cron_failure_summary().
    { path: "/api/cron/pg-cron-health", schedule: "0 9 * * *" },
  ],
  git: {
    deploymentEnabled: {
      main: false,
    },
  },
};
