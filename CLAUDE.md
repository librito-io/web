# CLAUDE.md — Librito Web

SvelteKit web app for the Librito cloud highlight sync system. Hosted at `https://librito.io`. Provides device pairing API, highlight sync API, and a browser-based highlight viewer. Deployed on Vercel (free tier) via `@sveltejs/adapter-vercel`. Self-hosters: see [Self-hosting](#self-hosting) for the one-line adapter swap. The device firmware defaults to `https://librito.io` as its API base URL.

## Librito Project Structure

Librito is split across two repos under the `librito-io` GitHub org:

- **`librito-io/reader`** — ESP32 firmware (PlatformIO). The e-ink book reader device.
- **`librito-io/web`** (this repo) — SvelteKit web app + Supabase project. All web UI, API endpoints, database schema, and migrations.

The device never talks to Supabase directly. All device communication goes through SvelteKit API routes, which use the Supabase `service_role` key server-side.

Design spec and implementation plans live in the reader repo at `docs/superpowers/specs/` and `docs/superpowers/plans/`.

Completed audit artefacts (closed working plans worth preserving in version control) live under `docs/audits/<date>-<topic>.md` — e.g. `docs/audits/2026-04-29-supabase-rls-and-migrations.md`.

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

# Supabase local
supabase start          # Start local Supabase
supabase db reset       # Reset and re-apply all migrations
supabase stop           # Stop local Supabase
```

**Migration CI gate**: `.github/workflows/migration-smoke.yml` runs `supabase start && supabase db reset --local` on every PR (and `main` push) that touches `supabase/migrations/**`, `supabase/seed.sql`, or `supabase/config.toml`. The CLI is pinned to the version used for local dev and production `supabase db push` so parser-class regressions (cf. PR #41 — CLI v2.90 prepared-statement parser batches multi-statement migrations into one Parse message and trips Postgres SQLSTATE 42601) surface in CI rather than at production push time. If you edit a migration file mid-review, **re-run `supabase db reset --local` locally** before pushing — CI is the safety net, not the primary signal.

## Local dev setup — Realtime signing key

Tests run on CI without any Supabase setup (the fixture in `tests/fixtures/dev-jwk.ts` is self-contained). But the **manual local Realtime smoke test** — minting a token from `/api/realtime-token` and joining a Phoenix channel against local Supabase — requires that local gotrue and our minter share a signing key.

One-time bootstrap on each dev machine:

1. Generate two ES256 keys (one current, one standby):

   ```bash
   supabase gen signing-key --algorithm ES256
   supabase gen signing-key --algorithm ES256
   ```

   `supabase gen signing-key --append` prints to stdout but does NOT write the file (CLI v2.90 behavior). Capture both stdout outputs by hand.

2. Create `supabase/signing_keys.json` (gitignored) as a JSON array. Mark one key as current, the other as standby. Local gotrue (≥ v2.188) refuses more than one key with `key_ops: ["sign"]`, so the standby gets `key_ops: ["verify"]` only:

   ```json
   [
     {
       "kty": "EC",
       "kid": "<uuid-1>",
       "use": "sig",
       "key_ops": ["sign", "verify"],
       "alg": "ES256",
       "ext": true,
       "d": "...",
       "crv": "P-256",
       "x": "...",
       "y": "..."
     },
     {
       "kty": "EC",
       "kid": "<uuid-2>",
       "use": "sig",
       "key_ops": ["verify"],
       "alg": "ES256",
       "ext": true,
       "d": "...",
       "crv": "P-256",
       "x": "...",
       "y": "..."
     }
   ]
   ```

3. In `supabase/config.toml`, uncomment the `signing_keys_path` line under `[auth]`:

   ```toml
   [auth]
   signing_keys_path = "./signing_keys.json"
   ```

   This is a per-dev local modification — do NOT commit. The committed form keeps the line commented to match the upstream Supabase CLI template default; CI, fresh clones, and self-hosters need it that way so `supabase start` doesn't error on a missing key file. The Supabase CLI does not support `env(...)` substitution for `signing_keys_path` ([`pkg/config/auth.go:163`](https://github.com/supabase/cli/blob/v2.90.0/pkg/config/auth.go#L163) declares it as a plain `string`, not the `Secret` wrapper type), so there is no committed form that works for everyone — the line must stay commented in version control.

   To prevent the local edit from following you into accidental commits, mark the file as locally modified:

   ```bash
   git update-index --skip-worktree supabase/config.toml
   ```

   Undo when you need to pull a real upstream change to this file:

   ```bash
   git update-index --no-skip-worktree supabase/config.toml
   git pull
   # re-apply the uncomment, then re-skip:
   git update-index --skip-worktree supabase/config.toml
   ```

4. Set `LIBRITO_JWT_PRIVATE_KEY_JWK` in your `.env` to the **standby** key's full JWK as a single-line JSON string (include the `d` field — the minter signs with it).

5. Restart Supabase: `supabase stop && supabase start`.

6. Confirm both `kid`s appear at `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`.

Production keys are managed entirely through Supabase Dashboard → Project Settings → JWT signing keys → "new standby key", and `LIBRITO_JWT_PRIVATE_KEY_JWK` in Vercel Production env. Production keys never touch a developer's disk.

## Release Process

**Vercel deploys only the application code. Supabase database migrations do not run automatically.** These are two separate systems with no built-in link.

When a PR adds or modifies a file in `supabase/migrations/`, the migration reaches production in a second step performed manually after the PR merges:

```bash
# From a machine already linked to the production Supabase project
# (one-time setup: `supabase login` + `supabase link --project-ref <ref>`)
cd /path/to/web
git checkout main && git pull
supabase migration list        # confirm local has a migration remote does not
supabase db push --dry-run     # preview what would apply
supabase db push               # apply
```

Forgetting this step looks like a post-deploy 500 from any endpoint that reads a new column, because the deployed code references schema the database does not yet have. Always run `supabase migration list` before declaring a schema-touching deploy complete.

For recurring schema work, consider wiring a GitHub Action that runs `supabase db push` on merge to main. At current release cadence (solo dev, ad-hoc schema work) the manual step is preferred — it forces a deliberate "production write" pause.

## Self-hosting

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

Env vars required regardless of host: see [Environment Variables](#environment-variables). Supabase, Upstash Redis, and the JWT signing key are platform-agnostic; only the SvelteKit adapter is Vercel-specific.

## PR & Commit Convention

Squash-merge is the default. Repo is configured with `squash_merge_commit_message: COMMIT_MESSAGES` and `squash_merge_commit_title: COMMIT_OR_PR_TITLE` — the squash commit body is auto-generated by concatenating the branch's commit messages, so commit messages **are** the durable archeology in `git log`.

This implies a clean separation:

| Artifact                                         | Audience                              | Lifetime  | Contents                                                                       |
| ------------------------------------------------ | ------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| **Commit message**                               | Future `git log` / `git blame` reader | Permanent | What changed, why, non-obvious decisions, refs to spec sections                |
| **PR body** (`.github/pull_request_template.md`) | Reviewer + ops while PR is open       | Ephemeral | 1–3 line summary, test plan checkboxes, deploy/migration notes, reviewer hints |

**Rules of thumb**:

- Write commit messages as if no PR existed. Conventional Commits (`feat(scope):`, `fix(scope):`, `chore(scope):`, `test(scope):`) — see `git log` for examples.
- Do not duplicate archeology between PR body and commit messages. If something belongs in `git log`, put it in a commit message; the PR body links to "see commit messages" or summarizes in 1 line.
- Do not put test-plan checkboxes in commit messages — they're complete by merge time and pollute history.
- For multi-commit branches, prefer multiple small commits with focused messages over one giant commit. The squash concatenation handles the rest.
- When commit-message quality on a branch is uneven (e.g. fixup commits), edit the squash body manually at merge time:
  ```bash
  gh pr merge <N> --squash \
    --subject "<conventional-commits subject>" \
    --body "$(cat /path/to/tidied-archeology.md)"
  ```
- A new `.github/pull_request_template.md` populates the PR body — keep it slim and follow its structure.

## Project Structure

```
src/
  lib/
    server/
      auth.ts           # Device token authentication (SHA-256 hash lookup)
      errors.ts          # jsonError() / jsonSuccess() response helpers
      pairing.ts         # Pairing business logic (request, poll, claim)
      ratelimit.ts       # Upstash Redis rate limiter instances
      supabase.ts        # Admin client factory (service_role key)
      sync.ts            # Sync types, validation, and merge logic
      tokens.ts          # Token generation (pairing codes, device tokens, SHA-256 hash)
  routes/
    api/
      pair/
        request/         # POST: device requests a pairing code
        status/[pairingId]/ # GET: device polls for claim result
        claim/           # POST: authenticated user claims a code
      sync/              # POST: device syncs highlights
    app/                 # Auth-guarded app pages
      devices/           # Device management (list, rename, revoke)
    auth/
      login/             # Email/password login
      signup/            # Email/password signup
      callback/          # OAuth code exchange
tests/
  helpers.ts             # Mock Supabase client + mock Redis factories
  lib/                   # Unit tests organized by module
supabase/
  migrations/            # Database schema (9 migration files)
  config.toml            # Supabase project config
  seed.sql               # Development seed data
```

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
- `cover_cache` — shared cover library (deduplicated by ISBN, permanent)

**Sync hot path indexes**: `(user_id, updated_at)` on highlights and notes. The `updated_at` trigger fires on every row change, making `WHERE updated_at > :lastSyncedAt` pick up all changes including soft-deletes.

**Token lookup index**: `devices.api_token_hash` indexed for O(1) device authentication.

## Environment Variables

See `.env.example`. Required:

- `PUBLIC_SUPABASE_URL` — Supabase project URL
- `PUBLIC_SUPABASE_ANON_KEY` — Supabase public anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key (server-side only, bypasses RLS)
- `UPSTASH_REDIS_REST_URL` — Upstash Redis URL
- `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis token
- `LIBRITO_JWT_PRIVATE_KEY_JWK` — Full JWK JSON (single line, includes `d`) of the Supabase standby signing key. Server-side only. Signs `/api/realtime-token` ES256 tokens; Realtime verifies via Supabase's project JWKS where the public side is published. Rotation runbook: `docs/ws-rt-follow-ups.md` item 8.

## Code Style

- TypeScript strict mode
- Svelte 5 runes (`$state`, `$props`, `$derived`)
- `camelCase` for variables/functions, `PascalCase` for types/interfaces
- Explicit return types on exported functions
- `import type` for type-only imports
- Prettier with `prettier-plugin-svelte` for auto-formatting (`.prettierrc`). Run `npx prettier --write .` to format all files

## Implementation Phases

The cloud sync system is built incrementally. Each phase has a spec and plan in the reader repo at `docs/superpowers/specs/` and `docs/superpowers/plans/`.

| Phase | Status  | Scope                                                                            |
| ----- | ------- | -------------------------------------------------------------------------------- |
| 1     | Done    | Supabase setup (schema, auth, storage)                                           |
| 2     | Done    | Device pairing (API + web UI)                                                    |
| 3     | Done    | Sync API (auth middleware, merge logic)                                          |
| 4     | Done    | Web app highlight viewer + highlight feed                                        |
| 5     | Done    | Book transfer endpoints (client-side E2EE removed 2026-04-22, Identity A)        |
| 6     | Done    | ESP32 firmware sync client                                                       |
| WS-A  | Done    | Transfer schema consolidation + deletion hygiene + /privacy (2026-04-23)         |
| WS-B  | Planned | Embed signed download URL + sha256 in sync response (spec ready)                 |
| WS-C  | Planned | Firmware Range-resume, keep-alive, retry cadence, StatusBar + FileBrowser polish |
| WS-D  | Planned | Populate `attempt_count` / `last_error`; retry UI; attempt-cap → `failed`        |
| 7     | Planned | Further polish (realtime, covers, export)                                        |
