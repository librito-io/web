# CLAUDE.md — Librito Web

SvelteKit web app for the Librito cloud highlight sync system. Hosted at `https://librito.io`. Provides device pairing API, highlight sync API, and a browser-based highlight viewer. Deployed on Vercel (free tier) via `@sveltejs/adapter-vercel`. Self-hosters: see [Self-hosting](#self-hosting) for the one-line adapter swap. The device firmware defaults to `https://librito.io` as its API base URL.

## Librito Project Structure

Librito is split across two repos under the `librito-io` GitHub org:

- **`librito-io/reader`** — ESP32 firmware (PlatformIO). The e-ink book reader device.
- **`librito-io/web`** (this repo) — SvelteKit web app + Supabase project. All web UI, API endpoints, database schema, and migrations.

The device never talks to Supabase directly. All device communication goes through SvelteKit API routes, which use the Supabase `service_role` key server-side.

Design spec and implementation plans live in the reader repo at `docs/superpowers/specs/` and `docs/superpowers/plans/`.

Completed audit artefacts (closed working plans worth preserving in version control) live under `docs/audits/<date>-<topic>.md` — e.g. `docs/audits/2026-04-29-supabase-rls-and-migrations.md`. Working audit docs (mid-fix trackers updated as PRs land) live in the gitignored `docs/audits-wip/` folder; graduate to tracked `docs/audits/` via a dedicated PR once the audit is closed.

## Tech Stack

| Layer          | Technology            | Notes                                                                  |
| -------------- | --------------------- | ---------------------------------------------------------------------- |
| Web framework  | SvelteKit (Svelte 5)  | TypeScript, `adapter-vercel` (swap to `adapter-node` for self-hosting) |
| Database       | Supabase (Postgres)   | Auth, Storage, Realtime. Migrations in `supabase/migrations/`          |
| Auth (browser) | `@supabase/ssr`       | SSR cookie-based sessions, anon key                                    |
| Auth (device)  | SHA-256 token hashing | Device sends `Bearer sk_device_xxx`, server hashes and looks up in DB  |
| Rate limiting  | Upstash Redis         | `@upstash/ratelimit` sliding window, serverless                        |
| Testing        | vitest                | Unit tests with mock Supabase client                                   |

## Architecture

```
ESP32 Device ──Bearer token──→ API Routes (/api/*) ──service_role──→ Supabase
                                    │
Browser ──cookie session──→ App Routes (/app/*) ──anon key + RLS──→ Supabase
```

**Two auth models:**

- **Device API** (`/api/sync`, `/api/pair/*`, `/api/transfer/*`): Device sends `Authorization: Bearer sk_device_xxx`. Auth middleware (`src/lib/server/auth.ts`) hashes the token with SHA-256, looks up `devices.api_token_hash`, rejects if revoked. Uses `createAdminClient()` (service_role, bypasses RLS).
- **Browser sessions** (`/app/*`): Supabase SSR cookie-based auth via `@supabase/ssr`. Auth guard in `/app/+layout.server.ts` redirects unauthenticated users to `/auth/login`.

**Server hooks** (`hooks.server.ts`): Creates a per-request Supabase client with cookie persistence and exposes `safeGetSession()` on `event.locals`.

## Scaling Target

Design for ~1k concurrent users as the architectural baseline, even while the current userbase is pre-launch scale. Trade-offs that fall apart at 2-10× current scale are unacceptable. Paid tiers (Vercel Pro, Supabase Pro) are expected and budgeted at roughly 200+ users — free tier is a cost optimization, not an architectural constraint.

Stress-test every significant design decision against 200 and 1k users before locking it in. Breakers that only need money to fix (tier upgrade) are fine. Breakers that require rearchitecture are not. Flag the paid-tier threshold explicitly in any proposal so cost is visible.

Corollary: failed uploads, silent retries, or "rare-edge-case" UX regressions are not acceptable even at current scale, because the design must survive organic growth without a rewrite.

## Build Commands

```bash
# Development
npm run dev

# Build
npm run build

# Type check
npm run check

# Run all tests
npm test
# or: npx vitest run

# Run a specific test file
npx vitest run tests/lib/sync.test.ts

# Behavior-level migration integration suite (requires local Supabase running)
npm run test:integration

# Supabase local
supabase start          # Start local Supabase
supabase db reset       # Reset and re-apply all migrations
supabase stop           # Stop local Supabase
```

### Integration suite (`tests/integration/`)

`npm test` runs the fast hermetic unit suite (`tests/lib/`, `tests/routes/`) against mocks. **`npm run test:integration`** sets `INTEGRATION=1` and runs `vitest.integration.config.ts` against a running local Supabase (port `54322`); without the env var every `describe` is `.skipIf`'d. Helpers shell out to `supabase status -o env` for `DB_URL`/`API_URL`/`SERVICE_ROLE_KEY`, so no env wiring needed.

**Scope**: behavior-level guards unit tests can't catch — RPC tombstone filtering, `pg_cron` job presence + schedule, `supabase_realtime` publication membership, `REPLICA IDENTITY FULL` on replicated tables. Connects as superuser via `postgres-js`, impersonates via `request.jwt.claims` / `SET LOCAL ROLE authenticated` where needed. **RLS is out of scope** — separate suite. Serial: `pool: 'forks'`, `singleFork: true`, `sequence.concurrent` disabled.

**Migration CI gate** (`.github/workflows/migration-smoke.yml`): runs `supabase start && supabase db reset --local` then the integration suite + `gen:types` diff on every PR / `main` push that touches `supabase/migrations/**`, `supabase/seed.sql`, `supabase/config.toml`, `src/lib/types/database.ts`, `tests/integration/**`, or `vitest.integration.config.ts`. **CLI pin ≥ v2.91.1** — earlier versions carry the [`atomic` parser bug](https://github.com/supabase/cli/pull/5064) (function names containing "atomic" trip SQLSTATE 42601 on subsequent statements; hit prod via PR #40 → hotfix #41). Bumping the pin requires a coordinated bump of every contributor's local CLI and the laptop that runs `supabase db push`. Re-run `supabase db reset --local` locally before pushing migration edits — CI is the safety net, not the primary signal.

## Local dev setup — Realtime signing key

One-time per-machine bootstrap to share an ES256 key between local gotrue and the `/api/realtime-token` minter. See [`docs/dev/realtime-signing-key.md`](docs/dev/realtime-signing-key.md) for the full procedure. Production keys live in Supabase Dashboard → JWT signing keys + `LIBRITO_JWT_PRIVATE_KEY_JWK` in Vercel env — never on a developer disk.

## Release Process

Production deploys are automated via `.github/workflows/production-deploy.yml`. Push to `main` triggers the workflow.

**Flow:**

1. **changes** job: detect if `supabase/migrations/**` changed.
2. **migrate** job (conditional): if migrations changed, requires manual approval via the `production` GitHub environment, then runs `supabase db push --linked`. Migration failure blocks deploy.
3. **deploy** job: runs after migrate succeeds or is skipped (no migration changes). Deploys via `vercel deploy --prod`.
4. **smoke** job (post-deploy): probes every `crons[].path` in `vercel.ts` against the production deployment URL emitted by the `deploy` job (`vercel deploy --prod` stdout), asserting `200` with a valid `Bearer ${CRON_SECRET}` on `?probe=1` (handler short-circuits after auth) and `401` without auth on the canonical path. Catches the regression class from issue #187 / PR #188 (cron route accidentally POST-only, returning 405 to every Vercel cron fire) at deploy time. Failure fails the workflow run but does not roll back — the deploy is already live; smoke is a loud signal to fix-forward, not a gate. Probing the captured deploy URL (vs. a hardcoded canonical domain) means the job keeps working through future custom-domain swaps without an edit. See "Cron handlers" below for the `?probe=1` contract.

Vercel git auto-deploy on `main` is disabled in `vercel.ts` — the workflow is the single deploy source of truth. Preview deploys for PRs remain enabled.

**One-time GitHub setup**: create `production` environment with a required reviewer. Secrets needed: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `VERCEL_TOKEN`, `CRON_SECRET`. Variables: `SUPABASE_PROJECT_REF`, `VERCEL_ORG_ID` (from `.vercel/project.json`), `VERCEL_PROJECT_ID` (ditto). Workflow fails loudly when any are missing. **Token rotation**: 90 days.

**Migration CI gate** (still active): `.github/workflows/migration-smoke.yml` runs `supabase start && supabase db reset --local` on every PR and `main` push that touches migration files **or `src/lib/types/database.ts`**. This is the PR-time validator; `production-deploy.yml` is the production pusher. Both must stay in sync on Supabase CLI version (currently `2.95.4`). The previous post-`db push` drift-check job was removed because the production gen API drifts independently of project state on Supabase platform metadata changes — see Database Schema section.

## Self-hosting

Vercel adapter swap to `@sveltejs/adapter-node` is the only Vercel-specific bit. Full procedure (adapter swap, build/run, own-Supabase JWT signing key) in [`docs/dev/self-hosting.md`](docs/dev/self-hosting.md). Self-hosters do not need `.github/workflows/production-deploy.yml` and run `supabase db push` manually.

## Issue tracking

All work tracked in GitHub Issues under `librito-io` org's "Librito" Project (`https://github.com/orgs/librito-io/projects/1`). Spans both `librito-io/web` and `librito-io/reader`.

**Before filing any issue, read [`docs/dev/issue-tracking.md`](docs/dev/issue-tracking.md)** for full protocol (filing CLI two-step, label scheme, triage flow, audit-doc hybrid, model selection). Core invariants:

- **File immediately** for incidental finds during a primary task. Do not stash in markdown trackers. Do not create new follow-up `.md` docs.
- **Title**: imperative summary, no prefix. Type via Issue Type field (`Bug`/`Feature`/`Chore`/`Docs`), area via `area:*` label.
- **CLI flow** (gh ≤ 2.92 has no `--type` flag):
  ```bash
  ISSUE_URL=$(gh issue create --repo librito-io/web --title "..." --label "area:<x>" --body "...")
  gh api repos/librito-io/web/issues/${ISSUE_URL##*/} -F type=Chore --silent
  ```
- **Body**: four `##` sections in this order — `## Problem`, `## Solution` (mark `_unknown_` for bugs without known fix), `## Discovery` (link PR), `## Acceptance`.
- **Areas**: `area:sync` `area:auth` `area:catalog` `area:transfer` `area:realtime` `area:feed` `area:ui` `area:i18n` `area:docs` `area:db` `area:ci` `area:infra`.
- **Status labels**: `needs-triage` (auto, removed manually), `blocked` (external dep + comment naming blocker), `deferred` (must document revival trigger in body or close instead).
- **Naming**: descriptive 2–5 words. No opaque codes (`WS-*`, `Phase N`, `M1`). Done historical `Phase 1`…`Phase 6` keep numbered names; rule applies forward only.
- **Cross-repo**: two issues, one per repo, same Workstream value, cross-link in bodies. Don't combine.
- **Default model**: Opus inline for incidental finds; escalate to subagent (Haiku/Sonnet) only for bulk filing per the table in the extracted doc.

## PR & Commit Convention

Squash-merge default. Squash body concatenates branch commits (`squash_merge_commit_message: COMMIT_MESSAGES`), so **commit messages are the durable archeology**, not the PR body. PR title can become squash subject when commit quality is uneven.

**Read [`docs/dev/commits.md`](docs/dev/commits.md)** for length/shape rules, what-to-omit / what-to-keep tables, and the rationale-placement heuristic (when a "why" belongs in a code comment vs. commit message). Core invariants:

- **Conventional Commits** for commit AND PR titles: `feat(scope):` `fix(scope):` `bug(scope):` `chore(scope):` `docs(scope):` `test(scope):` `perf(scope):` `refactor(scope):`. PR title lint (`amannn/action-semantic-pull-request`) enforces lowercase subject, no trailing period.
- **Subject ≤50 chars**, imperative mood. **Body 3–7 lines default**, up to ~15 only for rejected alternatives / security implications / cross-cutting policy. Beyond 15 = smell; move to spec / audit doc / code comment and reference.
- **Omit from commit bodies**: verification sections (`vitest passes`), file lists (`git show --stat` exists), restated audit-doc content (link instead), per-commit Co-Authored-By when squashing (collapse to single trailer).
- **PR body** = ephemeral reviewer/ops doc (1–3 line summary, test plan, deploy notes). Do not duplicate archeology between PR body and commits.
- **Manual squash body** when commit quality is uneven: `gh pr merge <N> --squash --subject "..." --body "$(cat /tmp/tidy.md)"`.

## Code Patterns

**Response helpers**: All API responses use `jsonError(status, code, message, retryAfter?)` and `jsonSuccess(data)` from `src/lib/server/errors.ts`. Error shape: `{ error: "machine_code", message: "Human-readable" }`. 429s include `Retry-After` header.

**Business logic separation**: API route handlers (`+server.ts`) are thin — they parse input, call business logic functions (in `src/lib/server/*.ts`), and format responses. Business logic is independently testable.

**Mock Supabase**: Tests use `createMockSupabase()` from `tests/helpers.ts` — a Proxy-based chainable mock. Set expected results via `mock._results.set('table.operation', { data, error })`. Supports `.single()`, `.maybeSingle()`, and direct `await` (thenable chains).

**Mock Redis**: Tests use `createMockRedis()` — in-memory store with TTL support and `vi.fn()` spies.

**TDD approach**: Server helpers and business logic are built test-first. Write failing test → implement → verify pass → commit.

**`$env` imports in tests**: Modules importing `$env/static/private` (e.g., `ratelimit.ts`, `supabase.ts`) cannot be directly imported in vitest. Either mock the `$env` module with `vi.mock()` or test business logic that accepts these as injected parameters.

## Database Schema

Tables (see `supabase/migrations/` for full DDL):

- `profiles` — extends Supabase Auth users
- `devices` — paired e-readers (token hash, last sync time, revocation)
- `pairing_codes` — temporary 5-min TTL codes for device pairing
- `books` — per-user book metadata (keyed by FNV-1a hash from device)
- `highlights` — device-created highlights (soft-delete via `deleted_at`)
- `notes` — web-created notes (one per highlight)
- `book_transfers` — EPUB upload queue (48 h pending TTL; downloaded rows PII-scrubbed 24 h post-delivery, hard-deleted 24 h after scrub; expired rows scrubbed 49 h post-upload)
- `book_catalog` — shared per-ISBN book data (covers + textual metadata: title, author, blurb, publisher, page count, subjects, series). Deduplicated across users; renamed from `cover_cache` in `20260502000001`.

**Sync hot path indexes**: `(user_id, updated_at)` on highlights and notes. The `updated_at` trigger fires on every row change, making `WHERE updated_at > :lastSyncedAt` pick up all changes including soft-deletes.

**Token lookup index**: `devices.api_token_hash` indexed for O(1) device authentication.

**Generated TS types** (`src/lib/types/database.ts`): regenerated by `npm run gen:types`, which wraps `supabase gen types typescript --local > src/lib/types/database.ts`. Requires local Supabase running (`supabase status`); the script connects to the local Postgres on port 54322. After adding or changing a column on any table, run `npm run gen:types` and commit the updated `src/lib/types/database.ts` in the same PR as the migration. CI gates drift via `migration-smoke.yml`, which re-runs `gen:types` after `db reset --local` and fails on `git diff --exit-code src/lib/types/database.ts`. The trigger fires on changes to `supabase/migrations/**`, `supabase/seed.sql`, `supabase/config.toml`, **or `src/lib/types/database.ts`** — so a PR that manually edits the types file (without touching migrations) still goes through the same `--local` regen-and-diff validation. Production-side schema drift is monitored asynchronously by a separate weekly cron workflow (planned, see `docs/audits-wip/`); per-deploy production gen comparisons were removed because `supabase gen types typescript --project-id <ref>` output drifts independently of project state when the Supabase platform updates its emitted metadata, turning the gate into a flaky deploy blocker on changes outside our control.

Hand-maintained TS types that mirror DB tables derive from `Database['public']['Tables']['<name>']['Row']` (see `BookCatalogRow` in `src/lib/server/catalog/types.ts`) so a new column without a regenerated type file fails typecheck deterministically rather than drifting silently. When the generated row widens a project-specific literal union to `string | null` (e.g. `cover_storage_backend`), use `Omit<Row, '<field>'> & { <field>: <LiteralUnion> | null }` to preserve the narrow type.

### Function EXECUTE grants (REVOKE pattern)

Supabase bootstraps every Postgres project with `ALTER DEFAULT PRIVILEGES` that auto-grants EXECUTE on every newly-created `public.*` function to `anon`, `authenticated`, and `service_role` — this is how PostgREST exposes `/rest/v1/rpc/<name>`. Two consequences for every new function in `supabase/migrations/`:

1. **`REVOKE EXECUTE ... FROM PUBLIC` is necessary but not sufficient.** It strips the Postgres-level PUBLIC grant; it does NOT touch the per-role anon/authenticated grants Supabase applies via default privileges. Both layers are independent and must be revoked separately when a function has no legitimate caller from that role.

2. **The two-REVOKE template** for any new function in the `public` schema with no legitimate anon/authenticated caller:

   ```sql
   REVOKE EXECUTE ON FUNCTION public.<name>(<args>) FROM PUBLIC;
   REVOKE EXECUTE ON FUNCTION public.<name>(<args>) FROM anon, authenticated;
   GRANT  EXECUTE ON FUNCTION public.<name>(<args>) TO service_role;
   ```

   Reference template: [`supabase/migrations/20260521000001_pg_cron_failure_summary.sql`](supabase/migrations/20260521000001_pg_cron_failure_summary.sql). Issue #327 collected the gap and the audit migration ([`20260521000002_revoke_anon_authenticated_execute_audit.sql`](supabase/migrations/20260521000002_revoke_anon_authenticated_execute_audit.sql)) backfilled every existing function. PostgreSQL exempts triggers from EXECUTE checks, so trigger-only functions can still revoke from anon/authenticated without breaking the trigger fire — see `update_updated_at` and `devices_prevent_unrevoke` for working examples.

3. **For functions that ARE intentional PostgREST RPCs for authenticated callers** (e.g. `get_highlight_feed`, `get_library_with_highlights`): keep the `GRANT EXECUTE TO authenticated` but still `REVOKE FROM PUBLIC` and `REVOKE FROM anon`. The function's `auth.uid() IS NULL` short-circuit is not load-bearing; PostgREST should deny anon at the boundary, not return empty rows.

4. **Verifying** post-migration:

   ```sql
   SELECT grantee, routine_name
     FROM information_schema.role_routine_grants
    WHERE grantee IN ('anon', 'authenticated')
      AND routine_schema = 'public'
    ORDER BY routine_name;
   ```

   Only intentionally exposed RPCs (e.g. `get_highlight_feed`, `get_library_with_highlights`) should appear, and only with `authenticated`. Integration tests should assert `has_function_privilege('anon', 'public.<name>(<args>)', 'EXECUTE') = false` — never `SET LOCAL ROLE anon; SELECT fn()`, which segfaults the local Postgres 17.6 Docker image (see `tests/integration/pg-cron-health.test.ts` and `tests/integration/public-function-grants.test.ts` for the working pattern).

## Book catalog (covers + metadata)

Shared per-ISBN `book_catalog` table backing the highlight viewer. Code in `src/lib/server/catalog/` (orchestrators in `fetcher.ts`, HTTP clients per-source, mutex in `mutex.ts`) + `src/lib/server/cover-storage.ts` (Cloudflare Images on librito.io, Supabase Storage `cover-cache` for self-hosters). **Read [`src/lib/server/catalog/README.md`](src/lib/server/catalog/README.md)** for population paths (lazy / weekly warmup cron / operator bulk-seed), RPCs, and audit-column purpose. Load-bearing invariants below.

**Rate-limit layering (3 layers, do not collapse):**

1. **Per-user, fail-CLOSED** (`catalogUserLimiter`, 10 req/min) at API entry — caps a single user's fan-out.
2. **Per-ISBN / per-(title,author) mutex, fail-OPEN** (`catalog/mutex.ts`, `SETNX catalog:lock:isbn:${isbn}` / `catalog:lock:ta:${key}`, 30s TTL) — dedups concurrent resolves of same key. Loser short-circuits with `rateLimited: true`, consumes neither per-source budget nor `attempt_count`. Distinct `isbn:` vs `ta:` namespaces are intentional. Acquire failure fails OPEN to match per-source posture; `persistCover` sha dedup is the upload backstop.
3. **Per-deployment per-source, fail-OPEN** — `catalogOpenLibraryLimiter` (80/5min), `catalogGoogleBooksLimiter` (800/day). 10/20% margin under each provider's cap.

**Cron**: `POST /api/cron/catalog-warmup`, `0 8 * * 1` in `vercel.ts`. Gated on `CATALOG_WARMUP_ENABLED=true`. Default source NYT bestsellers (requires `NYT_BOOKS_API_KEY`); accepts `{ "isbns": [...] }` body override (operator runbook in `scripts/data/README.md`).

**RPCs** `upsert_book_catalog_by_isbn` / `upsert_book_catalog_by_title_author` are granted to `service_role` only; explicitly revoked from `anon`/`authenticated`. (Partial-unique-index upsert; supabase-js `.upsert()` doesn't thread `WHERE` predicates.)

**Audit columns** (5 fields on `book_catalog`, populated every resolve): `gb_pdf_available`, `gb_viewability`, `gb_image_link_tiers` (GB-fetched only), `cover_aspect`, `cover_bytes_per_pixel` (acceptance-computed). Query patterns in `scripts/data/README.md`. Sentry warning `catalog_cover_suspect_low_bpp` at `bytes_per_pixel < 0.05` — outlier signal, expected single-digits/day.

## Cron handlers

Cron paths are declared in `vercel.ts` (`crons[]`) and live under `src/routes/api/cron/*/+server.ts`. Two invariants every cron handler must hold:

1. **Export `GET` (Vercel cron invokes via GET).** A POST-only handler returns 405 to every fire and is invisible until something downstream notices the work isn't happening. Cost us 18 days of broken scrub — issue #187 / PR #188. The deploy-time `smoke` job catches this regression class going forward.

2. **`?probe=1` short-circuit, gated after auth.** Smoke probes hit `?probe=1` with valid `Bearer ${CRON_SECRET}`; handler must return `200 {probe: true}` immediately, _after_ the auth check, _before_ any work (DB writes, Storage uploads, external API calls, rate-limit budget). Without this, every deploy would trigger a real cron run as a side effect — burning NYT/OpenLibrary/GoogleBooks budget and uploading covers for no reason. Pattern (lines 102-108 of `catalog-warmup/+server.ts`, 22-28 of `transfer-sweep/+server.ts`):

   ```ts
   if (!privateEnv.CRON_SECRET)
     return jsonError(500, "server_misconfigured", "CRON_SECRET unset");
   if (!authorized(request))
     return jsonError(401, "unauthorized", "Cron secret mismatch");
   if (url.searchParams.get("probe") === "1")
     return jsonSuccess({ probe: true });
   // ... real work
   ```

3. **Read `CRON_SECRET` via `$env/dynamic/private`, never `$env/static/private`.** CRON_SECRET is marked Sensitive in Vercel; static-imported sensitive vars bake empty strings into prebuilt deploys and every cron fire 401s. See "Environment Variables" below.

If you add a new cron path: update `vercel.ts`, follow these three rules, and the smoke job picks it up automatically without a workflow edit.

## Environment Variables

See `.env.example`. Required:

- `PUBLIC_SUPABASE_URL` — Supabase project URL
- `PUBLIC_SUPABASE_ANON_KEY` — Supabase public anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key (server-side only, bypasses RLS)
- `UPSTASH_REDIS_REST_URL` — Upstash Redis URL
- `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis token
- `LIBRITO_JWT_PRIVATE_KEY_JWK` — Full JWK JSON (single line, includes `d`) of the Supabase standby signing key. Server-side only. Signs `/api/realtime-token` ES256 tokens; Realtime verifies via Supabase's project JWKS where the public side is published. Rotation runbook: `docs/ws-rt-follow-ups.md` item 8.
- `PUBLIC_SITE_URL` — _Optional._ Canonical site URL for outbound email links (defaults to `https://librito.io` when unset). Self-hosters should set this to their deployed origin.
- `GOOGLE_BOOKS_API_KEY` — _Optional but strongly recommended._ Google Books API key used by the catalog resolver. Anonymous v1 quota is **0/day per project** (Google removed free anon access), so without a key the entire Google Books leg of the cover chain returns 429 → `tryGoogleBooksExtraLarge` and `enrichDescriptionWithGoogleBooks` both silently fall through, costing the premium 1200 px+ cover tier AND every book description. Free tier ~1000 req/day after enabling the Books API in any Google Cloud project. Self-hosters can omit; covers degrade to iTunes/OpenLibrary (300–500 px) and descriptions stay null. Mark as **Sensitive** in Vercel and read via `$env/dynamic/private` (see rule below).
- `SENTRY_DSN` — _Optional._ Sentry project DSN. When set, server-side errors (including `runInBackground` throws) flow to Sentry for operator alerting. librito.io: set in Vercel production + preview (Sensitive). Self-hosters: leave unset to disable, or set to your own Sentry / Sentry-compatible endpoint. Mark as **Sensitive** in Vercel and read via `$env/dynamic/private` (see rule below).
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` — _Optional._ Sentry build-time source-map upload. When all three are set, the Vite plugin uploads source maps so production stack traces map back to TypeScript. librito.io: set in Vercel production + preview AND GitHub Actions secrets (the production-deploy workflow injects from GH secrets directly, bypassing `vercel pull`'s Sensitive-redaction). Self-hosters: leave unset; build succeeds with unmapped stacks. Operator runbook: `docs/operations/sentry-runbook.md`.
- `PUBLIC_SENTRY_DSN` — _Optional._ Browser-side Sentry SDK init gate. When set, unhandled errors in the browser flow to the same Sentry project as server-side errors. Self-hosters: leave unset to disable browser capture (server-side `SENTRY_DSN` is independent). Same DSN value as `SENTRY_DSN`. Mark as **Encrypted** in Vercel — **NOT Sensitive** — because `PUBLIC_*` vars must reach the browser bundle and Sensitive treatment redacts them to empty strings, silently no-opping the init. See "Vercel Sensitive env vars" rule below — `PUBLIC_SENTRY_DSN` is the inverse case (Encrypted required, Sensitive forbidden).

### Vercel "Sensitive" env vars require `$env/dynamic/private`

Vercel env vars have a per-var `type`: `encrypted` (default, decryptable via CLI) or `sensitive` (locked, never decryptable post-creation — even by Vercel CLI). `vercel pull` redacts sensitive vars to empty strings. Our production-deploy.yml uses `vercel pull` → `vercel build --prebuilt` → `vercel deploy --prebuilt`, so any sensitive var read via `$env/static/private` gets baked into the deployed bundle as `""` and the route silently misbehaves at runtime (401 forever on auth-checked routes, silent fallback to defaults on config gates).

**Rule:** sensitive Vercel envs must be read via `$env/dynamic/private` (runtime read), never `$env/static/private` (build-time inlined). Verify type via `npx vercel env ls -F json production | jq '.envs[] | select(.key=="X") | .type'`. Currently sensitive in this project (must use dynamic): `CRON_SECRET`, `CATALOG_WARMUP_ENABLED`, `COVER_STORAGE_BACKEND`, `NYT_BOOKS_API_KEY`, `GOOGLE_BOOKS_API_KEY`, `LIBRITO_JWT_PRIVATE_KEY_JWK`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_IMAGES_API_TOKEN`, `PUBLIC_CLOUDFLARE_IMAGES_HASH`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `RESEND_API_KEY`. The smoke job catches CRON_SECRET regressions; other sensitive vars rely on this rule + code review. Add explicit `server_misconfigured` (500) guards at handler entry for the value you read, so a config drift surfaces loudly rather than silently. See `src/routes/api/cron/*/+server.ts` and `src/lib/server/cover-storage.ts` for the established pattern. Background: the bug surfaced via #195 / #196 after PR #195 added the smoke probe; rule applies to both production and any future preview-build flows that use `--prebuilt`.

**Inverse rule for `PUBLIC_*` vars:** `$env/dynamic/public` (and `$env/static/public`) publish values to the browser bundle. Sensitive vars are redacted to empty strings by `vercel pull` before `vercel build --prebuilt` runs, so a Sensitive-typed `PUBLIC_*` var becomes the empty string in the deployed bundle. Currently `PUBLIC_SENTRY_DSN` is the only var subject to this rule — it MUST be Encrypted in Vercel. Verify type via `npx vercel env ls -F json production | jq '.envs[] | select(.key=="PUBLIC_SENTRY_DSN") | .type'` — expected output: `"encrypted"`.

## Code Style

- TypeScript strict mode
- Svelte 5 runes (`$state`, `$props`, `$derived`)
- `camelCase` for variables/functions, `PascalCase` for types/interfaces
- Explicit return types on exported functions
- `import type` for type-only imports
- Prettier with `prettier-plugin-svelte` for auto-formatting (`.prettierrc`). Run `npx prettier --write .` to format all files

## Implementation Phases

Specs + plans live in the reader repo at `docs/superpowers/specs/` and `docs/superpowers/plans/`. Forward-looking work is tracked as Workstream values on issues (see [`docs/dev/issue-tracking.md`](docs/dev/issue-tracking.md)); Phases 1–6 are done.
