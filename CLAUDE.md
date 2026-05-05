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

# Supabase local
supabase start          # Start local Supabase
supabase db reset       # Reset and re-apply all migrations
supabase stop           # Stop local Supabase
```

**Migration CI gate**: `.github/workflows/migration-smoke.yml` runs `supabase start && supabase db reset --local` on every PR (and `main` push) that touches `supabase/migrations/**`, `supabase/seed.sql`, or `supabase/config.toml`. The CLI is pinned to the version used for local dev and production `supabase db push` so parser-class regressions surface in CI rather than at production push time. **Pin must stay ≥ v2.91.1** — earlier versions carry the [`atomic` parser bug](https://github.com/supabase/cli/pull/5064) that mishandles function names containing the substring "atomic" and trips Postgres SQLSTATE 42601 on subsequent statements (this hit production via PR #40 → hotfix PR #41). Bumping the pin requires a coordinated bump of every contributor's local CLI and the laptop that runs `supabase db push`. If you edit a migration file mid-review, **re-run `supabase db reset --local` locally** before pushing — CI is the safety net, not the primary signal.

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

Production deploys are automated via `.github/workflows/production-deploy.yml`. Push to `main` triggers the workflow.

**Flow:**

1. **changes** job: detect if `supabase/migrations/**` changed.
2. **migrate** job (conditional): if migrations changed, requires manual approval via the `production` GitHub environment, then runs `supabase db push --linked`. Migration failure blocks deploy.
3. **deploy** job: runs after migrate succeeds or is skipped (no migration changes). Deploys via `vercel deploy --prod`.

Vercel git auto-deploy on `main` is disabled in `vercel.ts` — the workflow is the single deploy source of truth. Preview deploys for PRs remain enabled.

**One-time GitHub setup (before workflow will succeed):**

Create environment named `production` (Settings → Environments) with at least one required reviewer. Then set:

| Type     | Name                    | Where to get it                                                                        |
| -------- | ----------------------- | -------------------------------------------------------------------------------------- |
| Secret   | `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) |
| Secret   | `SUPABASE_DB_PASSWORD`  | Supabase project → Settings → Database                                                 |
| Secret   | `VERCEL_TOKEN`          | [vercel.com/account/tokens](https://vercel.com/account/tokens)                         |
| Variable | `SUPABASE_PROJECT_REF`  | `<ref>` portion of your Supabase project URL                                           |
| Variable | `VERCEL_ORG_ID`         | `team_97PZEmFN50tinLPzmLF0ql0O` (from `.vercel/project.json`)                          |
| Variable | `VERCEL_PROJECT_ID`     | `prj_wl2OutUDRlAtw9N222fGzfg10uJQ` (from `.vercel/project.json`)                       |

If tokens are not set before the first merge, the workflow fails loudly — no deploy happens.

**Token rotation:** every 90 days. Regenerate via the respective dashboards, update the GitHub secret.

**Migration CI gate** (still active): `.github/workflows/migration-smoke.yml` runs `supabase start && supabase db reset --local` on every PR and `main` push that touches migration files **or `src/lib/types/database.ts`**. This is the PR-time validator; `production-deploy.yml` is the production pusher. Both must stay in sync on Supabase CLI version (currently `2.95.4`). The previous post-`db push` drift-check job was removed because the production gen API drifts independently of project state on Supabase platform metadata changes — see Database Schema section.

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

Self-hosters do **not** need `.github/workflows/production-deploy.yml` — it is Vercel-specific. Run `supabase db push` manually against your own Supabase project after each schema-touching deploy.

## Issue tracking

All work — bugs, features, chores, docs — is tracked in GitHub Issues under the `librito-io` org's "Librito" Project (`https://github.com/orgs/librito-io/projects/1`). The Project spans both `librito-io/web` and `librito-io/reader`. New issues from either repo auto-add to the Backlog column.

### When to file

- Incidental finds during a primary task — file immediately. Do not stash in markdown trackers.
- Bug encountered, not fixing now — file.
- Feature idea / tech-debt spotted — file.
- Already covered by an open issue — comment, don't dupe.
- Question with no clear answer — GitHub Discussions, not Issues.

### How to file

CLI (Claude default):

```bash
gh issue create --repo librito-io/web \
  --title "<type>(<area>): <imperative summary>" \
  --type "Bug" \
  --label "area:<x>,needs-triage" \
  --body "..."
```

Web UI: pick a template (Web bug / Feature request / Chore). Blank issues are disabled.

### Title format

`<type>(<area>): <imperative summary>` — Conventional Commits style.

Examples:

- `bug(catalog): NYT warmup leaks API key in logs`
- `feat(feed): add highlight export to markdown`
- `chore(ci): add database.ts to .prettierignore`

### Body sections (required for CLI-filed issues)

Use these exact `##` headings, in this order:

```markdown
## Problem

## Solution

## Discovery

## Acceptance
```

Content per section:

1. **Problem** — what's wrong / what's needed
2. **Solution** — concrete approach (mark optional / `_unknown_` for bugs without a known fix)
3. **Discovery** — which task/PR surfaced this (link the PR)
4. **Acceptance** — what does "done" look like

Half-formed issues become ghosts. No exceptions.

State (`blocked`, etc.) goes in **labels**, not body sections — do not add a 5th section for status flags.

**Templates intentionally diverge** — bug/feature/chore form templates serve external contributors and have richer per-type fields (Steps to reproduce, Browser/OS, Why, Scope, etc.). The 4-section canonical above is for CLI-filed issues by maintainers / Claude — internal scaffold for quick filing with full context.

### Issue type (native, org-level)

Set the **Issue Type** on every issue — `Bug`, `Feature`, `Chore`, or `Docs`. Issue Types are GitHub-native, org-level (cross-repo), filterable via `type:Bug` syntax. Templates set the type automatically; CLI uses `--type "Bug"`.

Type labels (`bug`, `feat`, `chore`, `docs`) are **not** used — superseded by Issue Types.

### Labels (this repo)

**Area** (pick one or more): `area:sync` `area:auth` `area:catalog` `area:transfer` `area:realtime` `area:feed` `area:ui` `area:i18n` `area:docs` `area:db` `area:ci` `area:infra`

**Status** (auto-applied / cross-cutting): `needs-triage`, `blocked`

### Triage

New issues auto-labeled `needs-triage` and added to Backlog. Triage at session start, or when Triage view has 3+ items. ~30 seconds per issue: confirm Issue Type, set area label(s), set Workstream if it fits a phase, remove `needs-triage`.

### Working an issue

Branch references the issue (`feat/highlights-export-md` for #42). PR body includes `Closes #42`. Project workflows handle Status transitions automatically (PR opened → In Progress, merged → Done).

### Closing without merging

Always close with a comment explaining why. No `wontfix` / `duplicate` / `invalid` labels — close-comment is the durable archeology.

### Cross-repo issues

Two issues, one per repo, same Workstream value, cross-link in bodies. Don't combine.

### Audit doc hybrid

Audit docs (`docs/audits-wip/` → `docs/audits/`) keep their place for structured campaigns but their role narrows: planner, not parallel backlog.

- Audit doc enumerates findings + decisions (fix / skip / defer)
- Each "fix" finding → file a GitHub issue, link from doc by issue number
- Skip findings stay in doc only — no issue, skip rationale = record
- Optional: set the same Workstream value on every issue spawned from one audit, for campaign-level Project view

### Naming conventions for workstreams / spec files / audit docs

Descriptive titles, 2–5 words. **No opaque codes** (`WS-*`, `Phase N`, `M1`, `Q3-2026`). Title Case for display, kebab-case for filenames. If scope can't be named in 5 words, decompose. Done historical phases (`Phase 1` … `Phase 6`) keep numbered names for accuracy — rule applies forward only.

`Workstream` is the custom Project field used for cross-repo phase grouping; GitHub's built-in `Milestone` field is **not** used.

### Markdown follow-up trackers (deprecated)

Old `docs/` root trackers (`book-catalog-follow-ups.md`, `ws-rt-follow-ups.md`, `post-launch-followups.md`) and per-task follow-up docs are deprecated. Surviving items migrate to issues. **Do not create new follow-up `.md` docs.**

### Model selection (Claude-driven filing)

| Operation                                | Model           |
| ---------------------------------------- | --------------- |
| Incidental find mid-session (1–2 issues) | Opus inline     |
| Bulk filing from a precise brief         | Haiku subagent  |
| Mixed decision + execution batches       | Sonnet subagent |
| Triage migration of legacy md trackers   | **Opus**        |
| Audit doc → issues batch                 | Sonnet subagent |
| Crowdin / dependency-PR auto-labeling    | Haiku subagent  |

Default Opus inline; escalate down only when the operation matches.

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

### Length & shape

Commit bodies should be **tight**. The standard:

- **Subject**: ≤50 chars, imperative mood, conventional-commits prefix (`feat(scope):`, `fix(scope):`, etc.).
- **Body**: 3–7 lines default. Explains WHY the change is non-obvious, not WHAT changed (the diff shows that).
- **Up to ~15 lines** when the change has rejected alternatives worth recording, security implications, subtle constraints, or numbered design decisions that future contributors would otherwise re-litigate.
- **Beyond 15 lines is a smell.** If the body is longer, the substance probably belongs in a spec, audit doc, plan, or code comment instead — and the commit should reference it (`See docs/audits-wip/<name>.md issue #N` / `Per spec §"Foo"`).

What to omit from commit bodies:

- **Verification sections** (`vitest passes, typecheck clean`) — table stakes, every commit is verified before push.
- **File lists** — `git show --stat` produces them on demand.
- **Restating linked archaeology** — if the audit/spec/plan already documents the rationale, link to it by issue number rather than copy-pasting.
- **Co-Authored-By per-commit** when multiple commits in a branch share the same author — collapse to a single trailer at the end of the squash body when tidying for merge.

What to keep, even if longer than 7 lines:

- **Rejected alternatives** ("considered X, ruled out because Y").
- **Cross-cutting policy decisions** that a single-file diff doesn't communicate (e.g., layered rate-limit policy, fail-OPEN vs fail-CLOSED choice).
- **Security implications** — explicit threat-model framing future contributors must respect.
- **Refs to commits being amended or partially reverted** — `Preserves the amend at <sha>` / `Supersedes <sha> approach`.

When tidying squash bodies (per `gh pr merge --squash --body ...`), apply the same rules — strip per-commit verification sections, file lists, and redundant audit-doc restatements; preserve the load-bearing rationale.

The bias is toward **"future-self skims and finds the gem fast"**, not toward exhaustive documentation. Spec docs, audit trackers, and CLAUDE.md itself carry the long-form story.

### Where design rationale lives

When a commit body is long because it carries design rationale, that rationale probably belongs in **code comments**, not the commit. Two different artifacts for two different audiences:

- **Commit message** → answers "why is this change happening?" Frozen at write time. Read mostly at `git blame` / `git log` archeology time.
- **Code comment** → answers "why does this code look this way?" Lives next to the code. Read every time someone modifies the affected lines.

Heuristic for picking:

| Rationale type                                                            | Home                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Why this algorithm or data structure                                      | Code comment at the implementation                                               |
| Why this change is happening now                                          | Commit message                                                                   |
| Rejected alternatives                                                     | Spec / audit doc; one-line summary in commit                                     |
| Concurrency model, lock ordering, mutex semantics                         | Code comment AT the lock acquire/release sites                                   |
| Subtle invariants ("array must be sorted before this call")               | Code comment at the call site                                                    |
| Security implications                                                     | Both — code comment to stop mistakes, commit to record the threat-model decision |
| Workarounds for external bugs                                             | Code comment WITH the condition for removal (e.g. "remove once Postgres ≥ 17.2") |
| Cross-cutting policy (e.g. fail-OPEN vs fail-CLOSED, rate-limit layering) | Code comment at the module top of the relevant primitive; reference from commits |

**Comment maintenance discipline:**

- Comments answer WHY, never WHAT. WHAT is the code's job.
- Place comments at the point of decision (call site, lock site, branch site), not buried at the top of a 500-line file.
- If a comment becomes wrong, delete it. Wrong comments are worse than missing ones.
- Refactors must update the comments they pass through, or remove them.

If you find yourself writing the same rationale in both the commit and a code comment, drop it from the commit. The commit can say "see JSDoc on `createUpstashMutex`" or similar.

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
- `book_catalog` — shared per-ISBN book data (covers + textual metadata: title, author, blurb, publisher, page count, subjects, series). Deduplicated across users; renamed from `cover_cache` in `20260502000001`.

**Sync hot path indexes**: `(user_id, updated_at)` on highlights and notes. The `updated_at` trigger fires on every row change, making `WHERE updated_at > :lastSyncedAt` pick up all changes including soft-deletes.

**Token lookup index**: `devices.api_token_hash` indexed for O(1) device authentication.

**Generated TS types** (`src/lib/types/database.ts`): regenerated by `npm run gen:types`, which wraps `supabase gen types typescript --local > src/lib/types/database.ts`. Requires local Supabase running (`supabase status`); the script connects to the local Postgres on port 54322. After adding or changing a column on any table, run `npm run gen:types` and commit the updated `src/lib/types/database.ts` in the same PR as the migration. CI gates drift via `migration-smoke.yml`, which re-runs `gen:types` after `db reset --local` and fails on `git diff --exit-code src/lib/types/database.ts`. The trigger fires on changes to `supabase/migrations/**`, `supabase/seed.sql`, `supabase/config.toml`, **or `src/lib/types/database.ts`** — so a PR that manually edits the types file (without touching migrations) still goes through the same `--local` regen-and-diff validation. Production-side schema drift is monitored asynchronously by a separate weekly cron workflow (planned, see `docs/audits-wip/`); per-deploy production gen comparisons were removed because `supabase gen types typescript --project-id <ref>` output drifts independently of project state when the Supabase platform updates its emitted metadata, turning the gate into a flaky deploy blocker on changes outside our control.

Hand-maintained TS types that mirror DB tables derive from `Database['public']['Tables']['<name>']['Row']` (see `BookCatalogRow` in `src/lib/server/catalog/types.ts`) so a new column without a regenerated type file fails typecheck deterministically rather than drifting silently. When the generated row widens a project-specific literal union to `string | null` (e.g. `cover_storage_backend`), use `Omit<Row, '<field>'> & { <field>: <LiteralUnion> | null }` to preserve the narrow type.

## Book catalog (covers + metadata)

Shared per-ISBN library backing the highlight viewer. Schema lives in
`book_catalog` (renamed from `cover_cache` in `20260502000001`). Logic is
split into:

- `src/lib/server/catalog/` — pure helpers (`isbn`, `title-author`,
  `cleanup`, `extract`), HTTP clients (`openlibrary`, `googlebooks`), and
  the `resolveIsbn` / `resolveTitleAuthor` orchestrators (`fetcher.ts`).
- `src/lib/server/cover-storage.ts` — backend abstraction. `librito.io`
  uses Cloudflare Images (`COVER_STORAGE_BACKEND=cloudflare-images`).
  Self-hosters use Supabase Storage's `cover-cache` bucket.
- `src/lib/server/wait-until.ts` — `runInBackground(event, work)` shim
  over `event.platform.context.waitUntil` with a local-dev fallback.

Population paths:

1. **Lazy on viewer first-render** — `runInBackground(event, resolveIsbn)`
   from the book detail loader (`src/routes/app/book/[bookHash]/+page.server.ts`)
   and `GET /api/book-catalog/[isbn]`. Cold miss returns
   `/cover-placeholder.svg`; cover materialises on next reload.
2. **Weekly warmup cron** — `POST /api/cron/catalog-warmup`, scheduled
   `0 8 * * 1` in `vercel.ts`. Authenticated via `CRON_SECRET`. Gated on
   `CATALOG_WARMUP_ENABLED=true` (default `false` for self-hosters).
   Default candidate source: NYT bestseller lists (requires
   `NYT_BOOKS_API_KEY`).
3. **Bulk seed (operator-triggered)** — same cron endpoint accepts an
   optional `{ "isbns": [...] }` JSON body to override the NYT default.
   Operator workflow in `scripts/data/README.md` (curl with `CRON_SECRET`).
   `MAX_PER_RUN=100` per invocation; rate-limit pacing means large lists
   need chunked invocations.

RPCs `upsert_book_catalog_by_isbn` / `upsert_book_catalog_by_title_author`
wrap the partial-unique-index upsert (supabase-js `.upsert()` doesn't
thread `WHERE` predicates through). Granted to `service_role` only;
explicitly revoked from `anon` and `authenticated`.

Rate limits are layered three-deep so a misbehaving user, a healthy-but-bursty
fleet, and an Upstash blip each have a distinct mitigation:

1. **Per-user, fail-CLOSED** — `catalogUserLimiter` (10 req / min,
   `src/lib/server/ratelimit.ts`) at the API handler / page loader entry
   point. Caps a single user's parallel cover-resolve fan-out (e.g. 500
   newly-synced ISBNs opened in tabs) so they cannot monopolize the
   per-deployment budget.
2. **Per-ISBN / per-(title,author) mutex, fail-OPEN** —
   `src/lib/server/catalog/mutex.ts`, threaded through `ResolveDeps`.
   `SETNX catalog:lock:isbn:${isbn}` (or `catalog:lock:ta:${key}`) with a
   30 s TTL. Two simultaneous resolves of the same uncached ISBN dedup —
   loser short-circuits with `rateLimited: true` and consumes neither
   per-source budget nor an `attempt_count` increment. Distinct
   namespaces (`isbn:` vs `ta:`) keep ISBN-keyed and title/author-keyed
   locks for the same physical book independent. Acquire failures
   fail-OPEN to match the per-source posture (an Upstash blip must not
   collapse all callers to placeholder); the byte-level sha dedup in
   `persistCover` is the remaining backstop against duplicated uploads.
3. **Per-deployment per-source, fail-OPEN** — `catalogOpenLibraryLimiter`
   (80 req / 5 min) and `catalogGoogleBooksLimiter` (800 req / day),
   both in `src/lib/server/ratelimit.ts`. Protects upstreams from us
   when Upstash is unhealthy (10 % / 20 % safety margin under each
   provider's published cap).

Self-hosters: leave `COVER_STORAGE_BACKEND` unset (defaults to `supabase`).
The cron is opt-in (`CATALOG_WARMUP_ENABLED=false`); without it, the
catalog populates entirely lazily as users open books.

## Environment Variables

See `.env.example`. Required:

- `PUBLIC_SUPABASE_URL` — Supabase project URL
- `PUBLIC_SUPABASE_ANON_KEY` — Supabase public anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key (server-side only, bypasses RLS)
- `UPSTASH_REDIS_REST_URL` — Upstash Redis URL
- `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis token
- `LIBRITO_JWT_PRIVATE_KEY_JWK` — Full JWK JSON (single line, includes `d`) of the Supabase standby signing key. Server-side only. Signs `/api/realtime-token` ES256 tokens; Realtime verifies via Supabase's project JWKS where the public side is published. Rotation runbook: `docs/ws-rt-follow-ups.md` item 8.
- `PUBLIC_SITE_URL` — _Optional._ Canonical site URL for outbound email links (defaults to `https://librito.io` when unset). Self-hosters should set this to their deployed origin.

## Code Style

- TypeScript strict mode
- Svelte 5 runes (`$state`, `$props`, `$derived`)
- `camelCase` for variables/functions, `PascalCase` for types/interfaces
- Explicit return types on exported functions
- `import type` for type-only imports
- Prettier with `prettier-plugin-svelte` for auto-formatting (`.prettierrc`). Run `npx prettier --write .` to format all files

## Implementation Phases

The cloud sync system is built incrementally. Each phase has a spec and plan in the reader repo at `docs/superpowers/specs/` and `docs/superpowers/plans/`.

Forward-looking phases use descriptive Workstream names per the Issue tracking naming rule. Done phases (`Phase 1` … `Phase 6`) keep numbered names for historical accuracy.

| Workstream                                         | Status  | Scope                                                                            |
| -------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| Phase 1                                            | Done    | Supabase setup (schema, auth, storage)                                           |
| Phase 2                                            | Done    | Device pairing (API + web UI)                                                    |
| Phase 3                                            | Done    | Sync API (auth middleware, merge logic)                                          |
| Phase 4                                            | Done    | Web app highlight viewer + highlight feed                                        |
| Phase 5                                            | Done    | Book transfer endpoints (client-side E2EE removed 2026-04-22, Identity A)        |
| Phase 6                                            | Done    | ESP32 firmware sync client                                                       |
| Transfer schema cleanup                            | Done    | Transfer schema consolidation + deletion hygiene + /privacy (2026-04-23)         |
| Signed download URLs                               | Planned | Embed signed download URL + sha256 in sync response (spec ready)                 |
| Firmware sync hardening                            | Planned | Firmware Range-resume, keep-alive, retry cadence, StatusBar + FileBrowser polish |
| Transfer retry UI                                  | Planned | Populate `attempt_count` / `last_error`; retry UI; attempt-cap → `failed`        |
| Realtime polish / Cover catalog / Highlight export | Planned | Decomposed from former "Phase 7" — three independent workstreams                 |
