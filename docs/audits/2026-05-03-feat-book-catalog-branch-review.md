# feat: book-catalog branch-review

**Branch:** `feat/book-catalog`
**Base:** `main` (merge-base used for diff)
**Commits ahead:** 21
**Files changed:** ~40 (+3,578 / −21)
**Date:** 2026-05-03
**Review scope:** Full branch diff — committed + uncommitted. CLAUDE.md compliance, bugs, security, type/perf, code clarity.
**Posture:** Open-source. Self-host parity is a first-class requirement. Architectural decisions must survive 1k concurrent users without rewrite.

---

## Methodology

Five parallel reviewers (one Sonnet per axis) read the full branch diff and the relevant source files end-to-end:

1. CLAUDE.md compliance
2. Bugs and logic errors
3. Security (OWASP-relevant)
4. Type safety, performance, code quality
5. Code simplification (clarity / maintainability)

Each issue was assigned a confidence score 0–100. High-impact claims were verified against source before inclusion; two were rejected as false positives (see below). Every remaining flagged issue is recorded here regardless of score so the open-source maintainer trail is complete.

---

## Verified false positives (excluded from issue table)

| ID | Original claim | Why rejected |
|---|---|---|
| FP-1 | `source_url` column missing from migration `20260502000001` (would crash RPC at runtime, conf 95). | Column originated on the predecessor `cover_cache` table at [`20260412000004_create_utility_tables.sql:44`](../../supabase/migrations/20260412000004_create_utility_tables.sql#L44). The rename migration (`ALTER TABLE cover_cache RENAME TO book_catalog`) carries the column over implicitly. RPC INSERT is correct. |
| FP-2 | "No tests for any catalog module — TDD rule violated" (conf 88). | Branch adds 11 test files: `tests/lib/catalog/{cleanup,extract,fetcher,googlebooks,isbn,openlibrary,title-author}.test.ts`, `tests/lib/{cover-storage,ratelimit,wait-until}.test.ts`, `tests/routes/{book-catalog-isbn,cron-catalog-warmup}.test.ts`, plus fixtures. Coverage extends to negative-cache, fail-open ratelimit, and cold-miss paths. |

---

## Issue table

Every issue raised by any reviewer, with verification result, score, and a single decision: **Fix** or **Skip**. "Score" is 0–100 confidence that the issue is real and worth acting on, scaled by codebase context (CLAUDE.md rules, scaling target, OS posture). Time-to-fix is intentionally not weighted.

| #  | Severity     | Score | File / Location | Issue | Decision | Rationale |
|----|--------------|------|------------------|-------|----------|-----------|
| 1  | Security     | 85   | [`src/routes/api/cron/catalog-warmup/+server.ts:18-22`](../../src/routes/api/cron/catalog-warmup/+server.ts#L18-L22) | `timingSafeEqual` early-returns on length mismatch — leaks `CRON_SECRET` length via timing. Also leaks via JS string-length comparison itself (V8 short-circuits on `.length`). | **✅ DONE** (commit 162f371, PR 1) | Function name promises constant-time; impl violates that. Cheap fix using Node `crypto.timingSafeEqual` on fixed-width SHA-256 digests. OS contributors will copy this pattern — must be correct. |
| 2  | Compliance   | 85   | [`src/lib/server/catalog/fetcher.ts:198-241, 385-430`](../../src/lib/server/catalog/fetcher.ts#L198-L241) | `do_not_refetch_description` column is a no-op. Migration adds the flag explicitly for publisher takedown ([migration:91](../../supabase/migrations/20260502000001_rename_cover_cache_to_book_catalog.sql#L91)) but neither `resolveIsbn` nor `resolveTitleAuthor` checks `existing?.do_not_refetch_description` before the Google Books description fallback. | **✅ DONE** (commits 5c82f0e + f41c441, PR 1) | Compliance/data-safety. Re-resolve after negative-cache TTL re-fills any takedown'd row. Initial fix (5c82f0e) over-applied flag to covers; amended (f41c441) to scope to descriptions only — GB cover fallback still runs. |
| 3  | Logic        | 85   | [`src/routes/api/cron/catalog-warmup/+server.ts:85-94`](../../src/routes/api/cron/catalog-warmup/+server.ts#L85-L94) | Cron skips every ISBN already in `book_catalog`, including negative-cache rows (`storage_path IS NULL`). Failed ISBNs never get retried by warmup; only the lazy path retries them after 30d TTL via `isFreshNegative`. | **✅ DONE** (commit 954b1a8, PR 1) | Defeats cron's "warm cold entries" purpose. `resolveIsbn` already has correct retry short-circuit ([fetcher.ts:86,116](../../src/lib/server/catalog/fetcher.ts#L86-L116)). Drop the `knownSet` filter (or restrict to `storage_path IS NOT NULL`) and let `resolveIsbn` decide. |
| 4  | Performance  | 80   | [`src/routes/api/cron/catalog-warmup/+server.ts:30-53`](../../src/routes/api/cron/catalog-warmup/+server.ts#L30-L53) | `fetchNytBestsellerIsbns` runs three list calls sequentially with no `AbortController` / per-fetch timeout. Cron blocks 3× upstream latency; if NYT hangs, function eats its full 300s timeout before main loop starts. | **✅ DONE** (commit 214a344, PR #72) | `Promise.all` is safe (independent endpoints) and saves 2× upstream latency. 5s `AbortController` per fetch caps tail latency. PR #72 also extracted `fetchNytBestsellerIsbns` to `src/lib/server/catalog/nyt.ts` per CLAUDE.md "thin handlers, business logic in src/lib/server" convention — SvelteKit treats every named export from `+server.ts` as a route handler attempt, so the helper had to move to be safely importable. |
| 5  | Type-safety  | 80   | [`src/lib/server/catalog/fetcher.ts:248-258`](../../src/lib/server/catalog/fetcher.ts#L248-L258) and call sites at [`+page.server.ts:97`](../../src/routes/app/book/[bookHash]/+page.server.ts#L97), [`[isbn]/+server.ts:70`](../../src/routes/api/book-catalog/[isbn]/+server.ts#L70) | `cover_storage_backend!` non-null assertion. Migration ADD COLUMN at [migration:17-18](../../supabase/migrations/20260502000001_rename_cover_cache_to_book_catalog.sql#L17-L18) has no NOT NULL constraint. Negative-cache rows (no cover available, no GB description) and legacy rows can have NULL here; call sites use `!` to suppress the type error. | **✅ DONE** (commits 828a2ec + 4e2b3e1, PR 1) | **Do NOT use blanket `NOT NULL`** — that breaks the documented invariant that negative-cache rows have BOTH `storage_path = NULL` AND `cover_storage_backend = NULL` (see migration COMMENT). Correct fix: (a) add a paired CHECK constraint coupling the two columns: `(storage_path IS NULL AND cover_storage_backend IS NULL) OR (storage_path IS NOT NULL AND cover_storage_backend IS NOT NULL)`; (b) refine `BookCatalogRow` into a discriminated union (`PositiveBookCatalogRow` with both non-null vs `NegativeBookCatalogRow` with both null). Call sites narrow via a type guard, eliminating `!` with type-system proof. Initial fix (828a2ec) widened SELECT-projection casts to `BookCatalogRow`; amended (4e2b3e1) to `Pick<BookCatalogRow, ...>` for compile-time selection-drift safety. |
| 6  | Architecture | 75   | [`src/routes/api/book-catalog/[isbn]/+server.ts:27-85`](../../src/routes/api/book-catalog/[isbn]/+server.ts#L27-L85) and [`+page.server.ts:83-117`](../../src/routes/app/book/[bookHash]/+page.server.ts#L83-L117) | API handler not thin — duplicates catalog SELECT + response shaping in two places. CLAUDE.md Code Patterns require business logic in `src/lib/server/`. | **✅ DONE** (commit ee14fcd, PR #73) | Extracted `getCatalogForBrowser(supabase, isbn, variant)` to `src/lib/server/catalog/view.ts`. Pick<BookCatalogRow, K> includes both discriminant columns so `hasCoverStorage()` distributes (PR 1 lesson — Partial collapses, Pick distributes). Cold-miss/hit response dedup (#18) and BookDetailCatalog hoist (#21) deferred to PR 4. |
| 7  | Reliability  | 75   | [`src/lib/server/catalog/fetcher.ts:68-84`](../../src/lib/server/catalog/fetcher.ts#L68-L84) | `selectBySha` swallows DB errors silently and returns `null`. On transient Supabase error the dedup check is bypassed and a duplicate upload is attempted. | **✅ DONE** (commit 214a344, PR #72) | Cloudflare 409 + Supabase `already exists` handling makes this _safe_ in practice but defeats the dedup intent on every transient error. Throw and let the cron's per-ISBN try/catch log it. Brings `selectBySha` in line with sibling `selectByIsbn` which already throws. |
| 8  | Security     | 70   | [`src/lib/server/catalog/googlebooks.ts:51-62`](../../src/lib/server/catalog/googlebooks.ts#L51-L62) | `fetchGoogleBooksCoverBytes` takes `rawUrl` from upstream JSON and fetches it with no host validation. SSRF surface if Google Books API is ever spoofed/MitM'd to return e.g. `http://169.254.169.254/...`. | **✅ DONE** (commit b0da9ad, PR 4) | Cheap and idiomatic for OS posture. Whitelist `books.google.com` + `lh3.googleusercontent.com`. Same hardening recommended for `fetchOpenLibraryCoverBytes` — apply consistently to both providers. |
| 9  | Resource     | 70   | [`src/lib/server/catalog/openlibrary.ts:74`](../../src/lib/server/catalog/openlibrary.ts#L74), [`googlebooks.ts:59`](../../src/lib/server/catalog/googlebooks.ts#L59) | `res.arrayBuffer()` buffers the full image in memory with no `Content-Length` check / max-byte cap. A malformed upstream response could OOM the function. | **✅ DONE** (commit 214a344, PR #72) | Two-layer cap applied symmetrically to both clients: (1) Content-Length pre-check rejects without buffering when upstream advertises an oversize payload (most CDNs set CL correctly — cheap savings); (2) post-arrayBuffer length check is the backstop for chunked encoding, CDNs that omit CL (lh3.googleusercontent.com observed omitting), and upstream lying about CL. 5 MB cap is generous (real covers run 100-600 KB). Constant duplicated per-file matching the existing COVER_MIN_BYTES pattern; consolidation deferred to audit fix #17 (PR 3) which handles http-client unification across both providers. **Limitation noted:** backstop fires AFTER arrayBuffer() resolves, so on missing-CL + actually-oversize response the function still buffers before rejecting. True streaming defense out of scope at current threat model. |
| 10 | Architecture | 70   | [`src/routes/api/cron/catalog-warmup/+server.ts:79,83`](../../src/routes/api/cron/catalog-warmup/+server.ts#L79-L83) | Cron calls `createAdminClient()` and global `fetch` directly — neither is injected. Existing test (`tests/routes/cron-catalog-warmup.test.ts`) compensates with `vi.mock`, but pattern resists easy mocking and breaks tracing on Vercel. | **✅ DONE** (commit ee14fcd, PR #73) | Destructured `fetch` from RequestEvent in cron POST handler; passes `event.fetch` to fetchNytBestsellerIsbns. New test locks the DI contract. **Audit's "thin handler wrapper" framing was overstated** — pre-flight grep confirmed every sibling API route calls `createAdminClient()` directly inside the handler. No wrapper pattern exists in this repo; admin-client invocation already at parity with sibling routes. |
| 11 | Performance  | 70   | [`src/routes/app/book/[bookHash]/+page.server.ts:107-117`](../../src/routes/app/book/[bookHash]/+page.server.ts#L107-L117) | No per-user rate limit before `runInBackground(resolveIsbn)`. Authenticated user with 500 newly-synced ISBNs opening pages in parallel triggers 500 concurrent background fetches; all share the global `"catalog"` rate-limit bucket; fail-open means upstreams take the brunt. | **✅ DONE** (commit 214a344, PR #72) | Layered policy matching realtimeToken precedent: per-deployment fail-OPEN (existing `catalogOpenLibraryLimiter` + `catalogGoogleBooksLimiter` inside resolveIsbn — protects upstreams from us when Upstash is unhealthy) + per-user fail-CLOSED (new `catalogUserLimiter`, 10/min keyed on `user.id`, gates work-scheduling at the entry point — protects us from a single user's bulk fan-out). Asymmetric entry semantics: `/api/book-catalog/[isbn]` returns 429 + Retry-After (programmatic clients back off via standard contract); `/app/book/[bookHash]` page loader treats limiter as boolean "should we schedule?" (silent degradation preserves read UX, page renders with placeholder rather than error page). ISBN deliberately excluded from the key — otherwise one user could spawn N distinct ISBNs at 10/min each and defeat the purpose. |
| 12 | Concurrency  | 70   | [`src/lib/server/catalog/fetcher.ts:104,316`](../../src/lib/server/catalog/fetcher.ts#L104-L316) | Two simultaneous tabs hitting the same uncached ISBN fire two concurrent `resolveIsbn` runs. Both upload, the second dedups by SHA, but both consume rate-limit tokens against upstreams. | **✅ DONE** (commit ee14fcd, PR #73) | New `src/lib/server/catalog/mutex.ts` with three impls: `createUpstashMutex(redis)` (production, SETNX EX 30, fail-OPEN), `createTestMutex()` (in-memory for concurrency tests), `noopMutex` (back-compat default). `getCatalogMutex()` lazy singleton keeps mutex.ts free of `$env/static/private` pulls. Lock check sits AFTER cache + fresh-negative guards and BEFORE per-source `tryAcquire`. Loser overloads `rateLimited: true` (Option A from audit). Three-layer rate policy now: per-user fail-CLOSED → per-ISBN fail-OPEN → per-source fail-OPEN. **Note**: commit `0ed94a1` (pre-squash) used `--no-verify` (no hooks active, harmless). Memory `never-use-no-verify-flag.md` saved to prevent recurrence. |
| 13 | Simplification | 90 | [`fetcher.ts:300-308`](../../src/lib/server/catalog/fetcher.ts#L300-L308) + [`cover-storage.ts:35-43`](../../src/lib/server/cover-storage.ts#L35-L43) | Identical private `sha256Hex` duplicated. | **✅ DONE** (commit ee14fcd, PR #73) | Hoisted to `src/lib/server/catalog/sha.ts`. Two NIST SHA-256 KAT vectors in sha.test.ts guard against silent algorithm changes — image-dedup correctness depends on byte-identical hashing across both call sites. |
| 14 | Simplification | 80 | [`fetcher.ts:104-298, 316-477`](../../src/lib/server/catalog/fetcher.ts#L104-L298) | `resolveIsbn` and `resolveTitleAuthor` ~60% identical: GB description fallback, storage+dedup block, upsert shape, four identical `try { ... } catch (err) { console.warn(...) }` blocks. | **✅ DONE** (commit ee14fcd, PR #73) | Extracted `enrichWithGoogleBooks`, `persistCover`, `loadOpenLibraryData`, `resolveOpenLibraryCover`. Eliminates ~60% duplication; consolidates four scattered GB error-log sites. Preserves PR 1 amend f41c441: `do_not_refetch_description` gates description text only, not cover fallback. New regression-guard test for title/author flag-set + no-OL-cover → GB cover fallback applied — locks the description/cover scope at the helper boundary. |
| 15 | Simplification | 75 | [`fetcher.ts:104-298`](../../src/lib/server/catalog/fetcher.ts#L104-L298) | `resolveIsbn` is a 195-line function that mixes 5 concerns (cache check, OL data fetch, OL cover resolution, GB fallback, storage+upsert). Numbered comments `// 1. ...`, `// 2. ...`, `// 3. ...` are a tell. | **✅ DONE** (commit ee14fcd, PR #73) | Landed paired with #14 in same commit. Each numbered section now a function: `loadOpenLibraryData`, `resolveOpenLibraryCover`, `enrichWithGoogleBooks`, `persistCover`. Resolver bodies scan independently; per-source try/catch co-located in helper. |
| 16 | Simplification | 75 | [`fetcher.ts:128-159`](../../src/lib/server/catalog/fetcher.ts#L128-L159) | `(olData as { works?: ... }).works` cast repeated 4×. `fetchOpenLibraryByIsbn` already returns the typed `OpenLibraryDataDoc \| null` ([types.ts:11-22](../../src/lib/server/catalog/types.ts#L11-L22)). | **✅ DONE** (commit 8df3cfb, PR 4) | Drop all four casts; rely on the typed return + optional chaining. The casts paper over a previous loose type that no longer exists. |
| 17 | Simplification | 75 | [`openlibrary.ts:11-19,66-77`](../../src/lib/server/catalog/openlibrary.ts#L11-L77) and [`googlebooks.ts:8-17,51-62`](../../src/lib/server/catalog/googlebooks.ts#L8-L62) | Same UA constant, same `fetchJson` shape, same `fetchCoverBytes` shape across both clients (only `COVER_MIN_BYTES` differs). | **✅ DONE** (commit ee14fcd, PR #73) | New `src/lib/server/catalog/http.ts`: `fetchCatalogJson` + `downloadCover`. Both PR 2 fix #9 size-cap layers preserved (Content-Length pre-check + post-buffer backstop). Provider modules retain URL construction, response parsing, and provider-specific min/max thresholds passed as args. **Seam comment marks where PR 4 #8 SSRF allowedHosts check lands.** |
| 18 | Simplification | 70 | [`/api/book-catalog/[isbn]/+server.ts:48-85`](../../src/routes/api/book-catalog/[isbn]/+server.ts#L48-L85) | Cold-miss and hit response branches duplicate ~13 metadata fields. Differ only in `cover_url` and `cold_miss`. | **✅ DONE** (commit e2b6e1a, PR 4) | Build base shape once from `data`, spread into both branches with the differing fields. Eliminates drift when columns are added. Pairs with #6 (single shared view fn). |
| 19 | Simplification | 65 | [`fetcher.ts`](../../src/lib/server/catalog/fetcher.ts) — single-letter identifiers | `e` (lines 335, 345, 466), `m` (line 157, 394), `wk` (line 134), `r` (lines 97, 100). | **✅ DONE** (commit 192dc72, PR 4) | Rename to `existing` / `match` / `workKey` / `limit`. Zero-cost readability; OS posture rewards explicit names. |
| 20 | Simplification | 60 | [`/api/cron/catalog-warmup/+server.ts:65-77`](../../src/routes/api/cron/catalog-warmup/+server.ts#L65-L77) | Inline body parse for `bodyIsbns` mixes parsing concerns into the POST handler. | **✅ DONE** (commit 872e1ea, PR 4) | Extract `parseIsbnsFromBody(request): Promise<string[] \| null>`. Keeps handler at orchestration level. |
| 21 | Simplification | 55 | [`+page.server.ts:65-81,94-106`](../../src/routes/app/book/[bookHash]/+page.server.ts#L65-L106) | Inline 7-field type literal repeated implicitly between init and populated branch. | **✅ DONE** (commit 5037350, PR 4) | Hoist to exported `type BookDetailCatalog` near the load fn or in `$lib/feed/types`. The Svelte page consumes this shape; sharing tightens contract. |
| 22 | Simplification | 50 | [`wait-until.ts:19-21`](../../src/lib/server/wait-until.ts#L19-L21) | Trailing comment after empty branch describes the absence of code. | **Skip** | Comment explains a non-obvious invariant (the rejection is captured by `.catch` above; running on the request task is acceptable in dev). It earns its keep — comment improvement is taste, not bug. Could move to JSDoc on the function but not required. |
| 23 | Architecture | 30   | [`+page.server.ts:108`](../../src/routes/app/book/[bookHash]/+page.server.ts#L108) | `createAdminClient()` used inside `runInBackground` from an `/app/*` loader (not `/api/*` device path). | **Skip** | This is the documented pattern in CLAUDE.md "Book catalog (covers + metadata)" section — the catalog write needs `service_role`, the read above it correctly uses the per-request anon client. Reviewer flagged as informational; no change needed. |
| 24 | Performance  | 50   | [`fetcher.ts`](../../src/lib/server/catalog/fetcher.ts) — sequential OL → GB fallback | Reviewer noted whether OL + GB could run in parallel. | **Skip** | Sequential is intentional fallback (only call GB if OL didn't yield enough). Parallelism would burn upstream rate-limit tokens unnecessarily and also conflicts with the per-source `tryAcquire` budget. Current design is correct. |
| 25 | Security     | 30   | [`openlibrary.ts:25,35`](../../src/lib/server/catalog/openlibrary.ts#L25-L36) | OL URLs interpolate ISBN without `encodeURIComponent`. | **Skip** | `canonicalizeIsbn` returns `\d{13}` only — no special chars possible. No exploit surface. Reviewer self-marked below threshold. |
| 26 | Architecture | 80   | [`src/lib/server/catalog/types.ts`](../../src/lib/server/catalog/types.ts) and the migration | `BookCatalogRow` (and other table-row types in `types.ts`) hand-maintained against the migration. Dual source-of-truth invariant; classic OS-project drift source. The first contributor to add a column without updating the type ships a silent type-vs-DB divergence. | **✅ DONE** (commits 74b5e13 + PR #71, PR 1 + post-merge fix) | Add `npm run gen:types` script. Refactor `BookCatalogRow` to derive from generated types. Three columns (`cover_storage_backend`, `description_provider`, `cover_source`) shipped as `text` with CHECK constraints rather than Postgres enums; required `Omit<Generated, ...> & { narrow types }` workaround in `types.ts`. Documented in CLAUDE.md; tracked as follow-up #11 for potential conversion to PG enums. **Post-merge correction (PR #71):** initial fix wrote generated output to a NEW path `src/lib/db.types.ts` without removing the pre-existing `src/lib/types/database.ts` (already used by `transfer.ts` + `supabase.ts`). The pre-existing `production-deploy.yml` drift-check validates the older path, so it failed on the post-PR-1 main push because the older file was never regenerated against the new schema. PR #71 consolidated to the pre-existing path: gen:types now writes to `src/lib/types/database.ts`, both drift-checks (migration-smoke at PR time + production-deploy after migrate) target the same file. **Lesson:** before adding new infrastructure, audit for pre-existing equivalents — particularly for "structural" patterns (env vars, type generation, CI gates, helper modules) where duplication compounds drift risk. |

Total: 26 distinct issues. **Fix: 22 (all DONE: 5 in PR 1 + 4 in PR 2 + 7 in PR 3 + 6 in PR 4). Skip: 4 (#22 #23 #24 #25). Already-rejected (FP): 2.** Audit closed 2026-05-03. (Earlier footers said "Fix: 20" — original miscount; recounted at PR 3 close.)

### PR 1 status (2026-05-03 — merged)

First-wave fixes shipped via PR #70 (squash-merged) + PR #71 (post-merge corrective). Production deploy succeeded.

PR #70 first-wave commits (most-recent first):

- `4e2b3e1` — fix(catalog): tighten Pick projections at catalog read sites; document BookCatalogRowFields scope (issue #5 amend)
- `828a2ec` — fix(catalog): enforce storage_path/backend coupling via CHECK + discriminated union (issue #5)
- `74b5e13` — feat(types): generate db types from Supabase schema, gate drift in CI (issue #26)
- `954b1a8` — fix(cron): pass all candidate ISBNs through resolveIsbn so negative-cache rows retry after TTL (issue #3)
- `f41c441` — fix(catalog): scope do_not_refetch_description to descriptions only, allow GB cover fallback (issue #2 amend)
- `5c82f0e` — fix(catalog): honor do_not_refetch_description flag in resolveIsbn / resolveTitleAuthor (issue #2)
- `162f371` — fix(cron): use crypto.timingSafeEqual on hashed inputs for CRON_SECRET check (issue #1)

PR #71 corrective fix (issue #26 post-merge):

- Consolidated generated db types to the pre-existing `src/lib/types/database.ts` path. `production-deploy.yml`'s drift-check failed on PR #70's post-merge run because the older types file was never regenerated against the new schema. Single source of truth restored; both drift gates (migration-smoke + production-deploy) now target the same canonical file.

Verification gates green at every step: vitest 407 PASS / 0 FAIL, `npm run check` clean, gen:types drift gate clean, `supabase db reset --local` clean across all 33 migrations.

Branch protection note: direct push to main blocked by GH013 ("Changes must be made through a pull request"). PR #71 went through standard branch + squash-merge flow despite being a single corrective commit. Memory saved for future sessions: `main-branch-protection.md`.

### PR 2 status (2026-05-03 — merged)

Second-wave fixes shipped via PR #72 (squash-merged commit `214a344`). Production deploy succeeded.

Per-issue sub-commits within the squash body:

- `refactor(catalog): extract fetchNytBestsellerIsbns to lib/server/catalog/nyt` — prep for #4. Helper had to move out of `+server.ts` because SvelteKit treats every named export as a route handler attempt; per-CLAUDE.md "thin handlers, business logic in src/lib/server" convention.
- `fix(catalog): parallelize NYT bestseller fetch + 5s per-fetch timeout` — issue #4
- `fix(catalog): selectBySha throws on DB error to surface dedup failures` — issue #7
- `fix(catalog): cap upstream cover fetches at 5MB to bound function memory` — issue #9
- `fix(catalog): per-user rate limit on cold-miss work-scheduling` — issue #11

Verification gates green at every step. Production deploy clean.

PR 2 introduced no new migrations (DDL-free wave). drift-check correctly skipped on production-deploy run for that reason — see follow-ups doc item #12 for proposed loosening if this becomes a gap.

### PR 3 status (2026-05-03 — merged)

Third-wave fixes (architecture + simplification) shipped via PR #73 (squash-merged commit `ee14fcd`). Production deploy succeeded. Tests: 410 → 463 (+53). DDL-free wave; drift-check correctly skipped.

Per-issue sub-commits within the squash body (in landed order):

- `refactor(catalog): split resolvers into named helpers` — issues #14 + #15 (paired). Extracts `enrichWithGoogleBooks`, `persistCover`, `loadOpenLibraryData`, `resolveOpenLibraryCover`. Eliminates ~60% duplication between resolvers; consolidates four scattered GB error-log sites; preserves PR 1 amend `f41c441` (description-only takedown gating).
- `refactor(catalog): hoist sha256Hex to shared module` — issue #13. Two NIST KAT vectors guard against silent algorithm changes.
- `refactor(catalog): consolidate HTTP clients into shared module` — issue #17. New `http.ts` with `fetchCatalogJson` + `downloadCover`. Both PR 2 fix #9 size-cap layers preserved. Seam comment marks where PR 4 #8 SSRF allowedHosts check lands.
- `refactor(catalog): extract getCatalogForBrowser view helper` — issue #6. Pick<BookCatalogRow, K> includes both discriminant columns so `hasCoverStorage()` distributes (PR 1 lesson).
- `refactor(catalog): inject fetch into cron NYT fetch` — issue #10. event.fetch is auto-instrumented by Vercel runtime tracing. Audit's "thin handler wrapper" framing for createAdminClient was overstated — sibling routes already at parity.
- `feat(catalog): per-ISBN Upstash mutex dedups concurrent resolves` — issue #12. Three-impl mutex.ts (Upstash production, in-memory test, noop back-compat). Lock check sits AFTER cache + fresh-negative guards and BEFORE per-source tryAcquire.

Three-layer rate-limit policy now in place: per-user fail-CLOSED → per-ISBN mutex fail-OPEN → per-source fail-OPEN. Documented in CLAUDE.md "Book catalog" section.

Process notes from PR 3 worth preserving:

- **Commit-length norm established mid-PR.** Original draft squash bodies ran 250+ lines; tightened to ~67 lines (~73% reduction). New CLAUDE.md "Length & shape" + "Where design rationale lives" subsections codify the standard: subjects ≤50 chars, bodies 3-7 lines default, ≤15 only for load-bearing rationale (rejected alternatives, security implications, concurrency posture). Design rationale belongs in code comments / JSDoc, not commit bodies. Apply forward to PR 4.
- **`--no-verify` protocol violation.** Pre-squash commit `0ed94a1` (per-ISBN mutex) used `--no-verify`. No hooks were active so the bypass was harmless, but flagged as a CLAUDE.md violation. History preserved. Memory `never-use-no-verify-flag.md` saved to prevent recurrence in future subagent sessions.

### PR 4 status (2026-05-03 — merged)

Fourth-wave clarity sweep shipped via PR #74 (squash-merged). SSRF whitelist + type/cast/dedup/rename/extract simplifications. Tests: 469 → 479 (+10). DDL-free wave; drift-check correctly skipped on production-deploy.

Per-issue sub-commits within the squash body (in landed order):

- `fix(catalog): whitelist hosts in downloadCover` — issue #8. SSRF defense at the helper layer; per-provider allowedHosts threaded through DownloadCoverOptions; return-null posture matches sibling early-exit paths.
- `refactor(catalog): drop redundant casts in fetcher` — issue #16. PR 3's resolver split introduced `as never` and inline-widening casts; canonical `OpenLibraryDataDoc.cover` field already existed; dropped the type-bypass.
- `refactor(catalog): dedup cold-miss/hit response shape` — issue #18. baseFields hoisted; both response branches spread + override only the differing keys (cover_url, cold_miss). New regression test locks all 12 metadata fields in both branches.
- `refactor(catalog): rename r → limitResult in tryAcquire` — issue #19. Residual single-letter local; PR 3 cleaned the others during the resolver split.
- `refactor(catalog): extract parseIsbnsFromBody helper` — issue #20. Helper at `src/lib/server/catalog/parse.ts`; preserves empty-array semantics bit-for-bit.
- `refactor(catalog): hoist BookDetailCatalog type to view` — issue #21. Pick<CatalogView, 6 fields> & { cover_url: string }; book-detail page consumer unchanged.

Process notes from PR 4 worth preserving:

- Wave shipped under the new CLAUDE.md "Length & shape" + "Where design rationale lives" norms (codified during PR 3). Commit bodies in this wave averaged ~5-7 lines.
- DDL-free wave; drift-check correctly skipped on production-deploy.
- Tests: 469 → 479 (+10 from new tests for fixes #8 #18 #20).

---

## Architectural notes for OS posture

These are not bugs but cross-cutting observations that affect the open-source story. Treat them as advisory.

### 1. Dual-backend storage abstraction is correct, but document the operator workflow

The `cover-storage.ts` split (Cloudflare Images for `librito.io`, Supabase Storage for self-hosters) is exactly the right call: it picks up the right default automatically (`COVER_STORAGE_BACKEND` unset → `supabase`). Two follow-ups for OS posture:

- The Cloudflare Images path requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_IMAGES_API_TOKEN`, `PUBLIC_CLOUDFLARE_IMAGES_HASH`. `.env.example` should explicitly mark these as **librito.io-only** with a comment, so a self-hoster fork doesn't see them and assume they're required.
- The Cloudflare path returns a hardcoded `imagedelivery.net` URL — fine for librito.io but worth a comment-pointer in `coverUrl()` that self-hosters running their own Cloudflare account would just need to swap the hash env var.

### 2. The cron is opt-in by default — good, but document cost expectations

`CATALOG_WARMUP_ENABLED=false` default is correct for self-hosters. The 100 ISBN/run × NYT 3 lists × weekly cadence is also conservative. But the doc should call out:

- OpenLibrary rate-limit budget (80 req/5 min) is per-deployment, not per-user. A self-hoster with `CATALOG_WARMUP_ENABLED=true` consumes the same upstream budget as their users' lazy-resolve path.
- Google Books `apiKey` is optional but lifts the unauthenticated quota from 1000/day to 100k/day. Self-hosters at any non-trivial scale will want to provision one.

### 3. RPC + partial-unique-index pattern is correct, document the why

`upsert_book_catalog_by_isbn` / `upsert_book_catalog_by_title_author` exist because supabase-js `.upsert()` doesn't thread `WHERE` predicates through the partial unique indexes. CLAUDE.md already documents this. For OS contributors it's worth adding a one-line comment in the migration above the RPC bodies pointing at this constraint — future maintainers may try to "simplify" by using `.upsert()` and silently re-introduce the bug.

### 4. Fail-open rate limit policy is documented but per-user envelope is missing

CLAUDE.md describes both limiters as fail-open. That's the right default at the upstream-protection layer. Issue #11 above adds a per-user budget — the missing structural piece. Document the layered policy:

- **Per-deployment, fail-open**: protects upstream from us when Upstash is unhealthy.
- **Per-user, fail-closed**: protects us from a single user's bulk lookup pattern.

Both layers belong in `ratelimit.ts` and should be applied at every catalog entrypoint.

### 5. ~~The `BookCatalogRow` type lives in `catalog/types.ts` but the migration has no Postgres-typed source-of-truth check~~ — promoted to issue #26

Originally advisory; promoted to a tracked Fix (see issue #26 in the table). For an OS project the dual-source-of-truth invariant is one of the most predictable failure modes — the first contributor to add a column without updating the type ships a silent divergence. Generating types from the DB closes the loop.

### 6. Test fixtures are local JSON snapshots — flag the freshness contract (comment-only, not contract test)

`tests/fixtures/openlibrary/great-gatsby.json` and `tests/fixtures/googlebooks/great-gatsby.json` are static. If upstream API shapes drift, fixtures stay green while production breaks.

**Recommendation:** add a comment block at the top of each fixture (or a README in `tests/fixtures/<source>/`) capturing:

- Capture date
- Upstream URL the fixture came from
- One-line note on when to re-capture (e.g. "if Open Library changes /api/books response shape")

```jsonc
// Captured 2026-05-02 from:
// https://openlibrary.org/api/books?bibkeys=ISBN:9780743273565&format=json&jscmd=data
// Re-capture if Open Library changes response shape.
{ ... }
```

A scheduled contract test (env-gated, hits real APIs quarterly) was considered and rejected — over-engineering for current scale, recurring quota cost, false positives if upstream returns different list orderings on identical requests. Manual re-capture when test suite breaks is sufficient.

This is hygiene, not a blocker.

---

## Priority order for execution

If fixes are sequenced rather than batched:

1. **First wave (correctness + compliance)**: #2 (takedown flag), #5 (CHECK constraint + discriminated union), #1 (timing-safe), #3 (cron retry), #26 (gen:types infrastructure).
2. **Second wave (perf + reliability)**: #4 (NYT parallel + timeout), #7 (selectBySha throw), #9 (cover size cap), #11 (per-user rate limit).
3. **Third wave (architecture + simplification)**: #6 (extract catalog view), #14/#15 (resolver split), #13/#17 (helper consolidation), #10 (DI for fetch + admin client), #12 (per-ISBN mutex).
4. **Fourth wave (clarity sweep)**: #8 (SSRF whitelist), #16, #18, #19, #20, #21.

#22, #23, #24, #25 require no action.

### Ordering constraints within waves

These three issues touch the same code path (`runInBackground(resolveIsbn)` flow) and must land in the order below:

1. **#5 first** — discriminated `BookCatalogRow` changes the type returned by `selectByIsbn` / row reads. Downstream code adapts.
2. **#11 next** — per-user limiter wraps the entry point (page load / API handler), doesn't touch resolver internals. Slots in cleanly after #5.
3. **#12 last** — per-ISBN mutex lives inside the resolver. Easier to add once #14/#15 (resolver split) has separated concerns; otherwise the mutex acquisition adds another concern to an already-bloated function.

Land in any other order and refactor churn is guaranteed.

### Test discipline per fix

Per CLAUDE.md TDD posture and the existing project pattern (every fix on this branch followed failing-test-first cadence), each fix in waves 1–3 ships with a failing-test-first commit:

1. Write the test that demonstrates the bug or the missing behavior; verify it FAILS.
2. Implement the fix; verify the test PASSES.
3. Verify full suite still green (`npx vitest run`).
4. Commit fix + test together.

Skip TDD only for type-only or pure-rename changes (e.g., #19 single-letter rename, #21 type hoist) where there's no behavior to test. Document the skip in the commit body so the discipline trail is complete.

---

## PR-splitting strategy

20 fixes is too many for a single PR — reviewer signal degrades, blast radius compounds, rollback gets coarse. Split per wave; each PR is independently reviewable and revertable:

- **PR 1 — first wave (correctness + compliance)**: #1, #2, #3, #5, #26. Hard blocker for OS release per sign-off below. Targets `main`. Lands first.
- **PR 2 — second wave (perf + reliability)**: #4, #7, #9, #11. Branched off `main` after PR 1 merges. Independent of PR 3/4.
- **PR 3 — third wave (architecture + simplification)**: #6, #14, #15, #13, #17, #10, #12. Resolver split is the load-bearing piece; everything else aligns to it.
- **PR 4 — fourth wave (clarity sweep)**: #8, #16, #18, #19, #20, #21. Cosmetic but worth doing while OS posture is fresh.

Open the current `feat/book-catalog` branch as PR 1 once the first-wave fixes land. PRs 2–4 branch off main after each preceding PR merges; do not stack on `feat/book-catalog`.

Why not a single PR: at 20 fixes, the squash body becomes unreadable archeology, CI slows, any single regression forces all 20 to revert together. Wave splits keep blast radius bounded.

## Sign-off

No critical-severity issues. Branch is mergeable as PR 1 with the first-wave fixes landed.

**Hard blockers for OS release** (must land before publishing the repo):

- #2 (`do_not_refetch_description` no-op) — schema/code disagreement; silent regression on publisher takedowns.
- #5 (`cover_storage_backend!` non-null assertion) — type-system lie; will panic at runtime once a negative-cache row reaches `coverUrl()`.
- #1 (timing-safe equal) — security pattern OS contributors will copy.
- #3 (cron skips negative-cache) — defeats cron's stated purpose.
- #26 (gen:types infrastructure) — without this, the next contributor to add a column drifts the type silently.

Waves 2–4 are non-blocking for OS release but should land in the first month post-launch to keep the branch's quality posture from regressing under contribution churn.

When this audit closes (i.e., all Fix decisions have shipped or been re-decided as Skip), graduate this file to `docs/audits/2026-05-03-feat-book-catalog-branch-review.md` via a dedicated PR per CLAUDE.md convention.
