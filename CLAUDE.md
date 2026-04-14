# CLAUDE.md — Librito Web

SvelteKit web app for the Librito cloud highlight sync system. Hosted at `https://librito.io`. Provides device pairing API, highlight sync API, and a browser-based highlight viewer. Deployed on Vercel (free tier), portable to self-hosted Node.js via `adapter-node`. The device firmware defaults to `https://librito.io` as its API base URL.

## Librito Project Structure

Librito is split across two repos under the `librito-io` GitHub org:

- **`librito-io/reader`** — ESP32 firmware (PlatformIO). The e-ink book reader device.
- **`librito-io/web`** (this repo) — SvelteKit web app + Supabase project. All web UI, API endpoints, database schema, and migrations.

The device never talks to Supabase directly. All device communication goes through SvelteKit API routes, which use the Supabase `service_role` key server-side.

Design spec and implementation plans live in the reader repo at `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Tech Stack

| Layer          | Technology            | Notes                                                                 |
| -------------- | --------------------- | --------------------------------------------------------------------- |
| Web framework  | SvelteKit (Svelte 5)  | TypeScript, `adapter-auto` (swap to `adapter-node` for self-hosting)  |
| Database       | Supabase (Postgres)   | Auth, Storage, Realtime. Migrations in `supabase/migrations/`         |
| Auth (browser) | `@supabase/ssr`       | SSR cookie-based sessions, anon key                                   |
| Auth (device)  | SHA-256 token hashing | Device sends `Bearer sk_device_xxx`, server hashes and looks up in DB |
| Rate limiting  | Upstash Redis         | `@upstash/ratelimit` sliding window, serverless                       |
| Testing        | vitest                | Unit tests with mock Supabase client                                  |

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
- `book_transfers` — EPUB upload queue (7-day TTL)
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

## Code Style

- TypeScript strict mode
- Svelte 5 runes (`$state`, `$props`, `$derived`)
- `camelCase` for variables/functions, `PascalCase` for types/interfaces
- Explicit return types on exported functions
- `import type` for type-only imports
- Prettier with `prettier-plugin-svelte` for auto-formatting (`.prettierrc`). Run `npx prettier --write .` to format all files

## Implementation Phases

The cloud sync system is built incrementally. Each phase has a spec and plan in the reader repo:

| Phase | Status  | Scope                                   |
| ----- | ------- | --------------------------------------- |
| 1     | Done    | Supabase setup (schema, auth, storage)  |
| 2     | Done    | Device pairing (API + web UI)           |
| 3     | Done    | Sync API (auth middleware, merge logic) |
| 4     | Planned | Web app highlight viewer                |
| 5     | Planned | Book transfer endpoints                 |
| 6     | Planned | ESP32 firmware sync client              |
| 7     | Planned | Polish (realtime, covers, export)       |
