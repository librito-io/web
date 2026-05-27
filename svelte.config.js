// Pinned to adapter-vercel (production target). Self-hosters: swap to
// `@sveltejs/adapter-node` and run `node build/`. See CLAUDE.md → Self-hosting.
import adapter from "@sveltejs/adapter-vercel";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Pin runtime so the build doesn't auto-detect from the local Node
    // version (works on any host machine, matches Vercel's current LTS).
    adapter: adapter({ runtime: "nodejs24.x" }),
    version: {
      // Detect new deploys for pages kept open across a rollout. The
      // client polls `_app/version.json` every 5 min; on mismatch,
      // `updated.current` flips true and `beforeNavigate` in
      // `+layout.svelte` forces a full-page reload on the next nav so
      // the browser fetches the new chunk graph instead of `import()`-
      // ing assets that may have already rotated on the production
      // alias. Without this, lazy route chunks 404 with Safari
      // "Importing a module script failed" — issue #413, Sentry
      // LIBRITO-WEB-C. 5 min over 60 s because the failure window is
      // short and per-client poll traffic scales linearly with users;
      // tighten only if the residual rate proves it's needed.
      pollInterval: 300_000,
    },
  },
};

export default config;
