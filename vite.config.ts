import { sveltekit } from "@sveltejs/kit/vite";
import { sentrySvelteKit } from "@sentry/sveltekit";
import { defineConfig } from "vitest/config";

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
  server: {
    // `npm run dev:mobile` passes --host so a phone on the same Wi-Fi can
    // load http://<your-mac>.local:5173 (Bonjour mDNS, stable across DHCP).
    // Vite 6 rejects non-localhost Host headers by default (DNS-rebinding
    // guard), so allow the .local suffix. Default `npm run dev` stays
    // localhost-only — this only matters once --host exposes the LAN.
    allowedHosts: [".local"],
  },
  ssr: {
    noExternal: ["svelte-bricks"],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
  },
});
