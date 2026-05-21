# Book catalog (covers + metadata)

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

## Population paths

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

## Rate-limit layering

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

## Audit columns (plan 2026-05-18)

`book_catalog` carries five audit columns populated on every resolve to
let production SQL validate the GoogleBooks `pdf.isAvailable` filter
(Task 8, issue #209 revised mechanism) without log scraping:

- `gb_pdf_available`, `gb_viewability`, `gb_image_link_tiers` — captured
  whenever a GoogleBooks volume is fetched during the resolve, regardless
  of which source ends up winning. NULL when GB was not fetched.
- `cover_aspect`, `cover_bytes_per_pixel` — computed at acceptance.
  NULL for negative-cache rows.

Query patterns + post-deploy operator runbook live in
`scripts/data/README.md` ("Catalog cover audit").

Sentry warning `catalog_cover_suspect_low_bpp` fires when an accepted
GB cover has `cover_bytes_per_pixel < 0.05` — the false-negative signal
for the pdf.isAvailable filter. Outlier-only; expected single-digits/day.
