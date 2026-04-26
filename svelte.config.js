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
  },
};

export default config;
