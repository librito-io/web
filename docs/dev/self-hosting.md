# Self-hosting

Production runs on Vercel via `@sveltejs/adapter-vercel`. To self-host on Node.js (Docker, fly.io, bare metal, etc.):

1. Replace the adapter dep:
   ```bash
   npm uninstall @sveltejs/adapter-vercel
   npm install -D @sveltejs/adapter-node
   ```
2. In `svelte.config.js`, change the import line from `@sveltejs/adapter-vercel` to `@sveltejs/adapter-node`.
3. Build + run:
   ```bash
   npm run build
   node build/
   ```
4. Provision a Realtime signing key in your own Supabase project:
   ```bash
   supabase gen signing-key --algorithm ES256
   ```
   In your project's Dashboard → Project Settings → JWT signing keys → "new standby key", paste the JWK. Set `LIBRITO_JWT_PRIVATE_KEY_JWK` in your env to the same JWK JSON.

Env vars required regardless of host: see Environment Variables in `CLAUDE.md`. Supabase, Upstash Redis, and the JWT signing key are platform-agnostic; only the SvelteKit adapter is Vercel-specific.

Self-hosters do **not** need `.github/workflows/production-deploy.yml` — it is Vercel-specific. Run `supabase db push` manually against your own Supabase project after each schema-touching deploy.

The book catalog cron is opt-in: leave `CATALOG_WARMUP_ENABLED=false` and the catalog populates entirely lazily as users open books. Leave `COVER_STORAGE_BACKEND` unset to default to Supabase Storage's `cover-cache` bucket (Cloudflare Images is `librito.io`-specific). See [`src/lib/server/catalog/README.md`](../../src/lib/server/catalog/README.md) for catalog architecture.
