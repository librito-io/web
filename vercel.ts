// vercel.ts
import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "sveltekit",
  crons: [
    { path: "/api/cron/transfer-sweep", schedule: "0 3 * * *" },
    { path: "/api/cron/catalog-warmup", schedule: "0 8 * * 1" },
  ],
  git: {
    deploymentEnabled: {
      main: false,
    },
  },
};
