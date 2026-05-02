// vercel.ts
import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "sveltekit",
  crons: [{ path: "/api/cron/transfer-sweep", schedule: "0 3 * * *" }],
  git: {
    deploymentEnabled: {
      main: false,
    },
  },
};
