# Book Catalog — Follow-ups

Items deferred from the book-catalog implementation plan
(`librito/reader/docs/superpowers/specs/2026-05-02-book-catalog-covers-and-metadata-design.md`
and `.../plans/2026-05-02-book-catalog-implementation-plan.md`). Pick up
after the day-one cover + metadata feature ships and bakes for a few
weeks.

Each item lists the trigger (when it becomes worth doing), scope, and
the relevant context so we don't lose it as conversation context fills.

---

## 1. Highlight feed RPC — add ISBN, batch-resolve covers in feed cards

**Trigger:** day-one cover work merged + production-stable; visible UX
gap is "feed cards still render placeholder thumbnails on the highlight
feed and any library/shelf views."

**Why deferred:** the current `get_highlight_feed` RPC (latest version
in `supabase/migrations/20260429000004_rewrite_library_rpc_and_harden_feed_cursor.sql`)
returns `(highlight_id, book_hash, book_title, book_author,
book_highlight_count, chapter_index, chapter_title, start_word, end_word,
text, styles, paragraph_breaks, note_text, note_updated_at, updated_at,
next_cursor)`. No `book_isbn`. Adding it is a drop-and-recreate on a
hot-path RPC with its own audit history — too coupled to bundle with the
catalog work.

**Scope of follow-up plan:**

1. New migration `<date>_extend_get_highlight_feed_with_isbn.sql` —
   `DROP FUNCTION` then `CREATE OR REPLACE FUNCTION get_highlight_feed`
   with `book_isbn text` added to the `RETURNS TABLE` and `b.isbn AS book_isbn`
   in the `base` CTE.
2. Update `parseFeedRows` in `src/lib/feed/types.ts` to surface `book_isbn`.
3. Update `tests/lib/feed/` cursor / fixture tests to include the new
   field. Verify the L1 cursor-COALESCE fix from PR audit P1/P2/L1
   still holds.
4. Extend the highlight-feed loader (the page server load that hydrates
   feed rows) to:
   - Collect distinct canonical ISBNs from `rows`.
   - Run one `SELECT isbn, storage_path, cover_storage_backend FROM
book_catalog WHERE isbn IN (...)` (use `locals.supabase` — RLS
     allows authenticated reads).
   - Build a `Map<isbn, { cover_url }>` via `coverUrl(...)` from
     `$lib/server/cover-storage`.
   - For cold misses, kick off `runInBackground(event, () =>
resolveIsbn(adminClient, isbn, ...))` per missing ISBN. Use
     `createAdminClient()` for the fetcher write — RLS blocks
     non-service-role inserts.
5. Pass `coverUrl` prop into `HighlightCard` from the page render. The
   prop is already accepted (Task 17 already added the `coverUrl?: string`
   prop and the conditional `<img>` markup).
6. Manual smoke: feed page shows thumbnails for ISBNs already in the
   catalog; cold-miss ISBNs render placeholder, then thumbnail on the
   next refresh.

**Where the snippet was originally drafted:** the deferred Task 18
section of the catalog implementation plan still contains the proposed
batch-resolve code as a reference; copy and adapt rather than rewriting
from scratch.

**Risk envelope:** medium. Drop-and-recreate of a hot RPC; cursor-shape
backwards compatibility check required. Run the existing
migration-smoke CI gate (`supabase db reset --local`) and add a fresh
fixture-driven test for the new return shape before merging.

---

## 2. Remove `books.cover_path` column

**Trigger:** book detail page (Task 17 of the catalog plan) reads via
the `books → book_catalog ON books.isbn = book_catalog.isbn` JOIN at
production scale for ≥30 days without performance regression.

**Why deferred:** the spec's open-questions section leans toward
removal; the catalog plan keeps the column in place during initial
rollout to give the JOIN read-path time to bake. Dropping a column is
irreversible, so we defer until the JOIN approach is verified.

**Scope of follow-up plan:**

1. New migration `<date>_drop_books_cover_path.sql`:
   `ALTER TABLE books DROP COLUMN cover_path;`
2. Confirm no code references remain (`grep -rn "cover_path" src
tests`). The catalog-plan Task 17 read path uses `book_catalog.storage_path`,
   not `books.cover_path`.
3. Drop the migration `20260412000003` COMMENT line that references the
   column (`COMMENT ON COLUMN books.cover_path IS '...';`) — it
   becomes a dangling comment. Either drop it explicitly in the new
   migration, or leave it as a no-op against a missing column
   (Postgres allows that — comments on dropped columns are no-ops).
4. Run migration smoke locally (`supabase db reset --local`).

**Risk envelope:** low. Column has always been `NULL` (no fetcher ever
populated it). Removal is purely tidy-up.

---

## 3. Cloudflare Images dashboard — create named variants

**Trigger:** before flipping `COVER_STORAGE_BACKEND=cloudflare-images`
on `librito.io` production env. (Plan Task 20 calls this out as a
manual checklist item.)

**Why deferred:** dashboard config can't be encoded in the plan's TDD
flow. It's an out-of-band step.

**Scope:**

In Cloudflare dashboard → Images → Variants, create three named
variants matching the dimensions assumed by `coverUrl()`:

- `thumbnail` — fit `cover`, width 120, height 180, quality 80.
- `medium` — fit `cover`, width 300, height 450, quality 85.
- `large` — fit `cover`, width 600, height 900, quality 90.

Token scope: `Account.Cloudflare Images: Edit`. Store as
`CLOUDFLARE_IMAGES_API_TOKEN` in Vercel Production env. The account
hash is `PUBLIC_CLOUDFLARE_IMAGES_HASH` (also in Production env).

Verify after enabling: a sample upload to Cloudflare Images returns an
ID; the URL `https://imagedelivery.net/<hash>/<id>/thumbnail` returns a
120×180 image.

---

## 4. ISBNdb / paid metadata aggregator (escape hatch)

**Trigger:** if user feedback consistently flags blurb quality
("descriptions are wrong edition", "missing for half my books") AND the
free Open Library + Google Books combo can't close the gap.

**Why deferred:** spec already designed for this — `description_provider`
enum supports `'isbndb'` as a value. Free-tier coverage is expected to
be good enough for launch. ISBNdb is $14.95/mo (basic) or $74.95/mo
(premium with bulk download).

**Scope of follow-up plan:**

1. New module `src/lib/server/catalog/isbndb.ts` matching the
   `openlibrary.ts` / `googlebooks.ts` pattern (HTTP client with
   injected `fetchFn`, exported per-endpoint functions).
2. Provider-pluggable resolution chain in `src/lib/server/catalog/fetcher.ts`
   — currently hardcoded order `[openlibrary, google_books]`. Extend
   to read an env-configured order: `CATALOG_PROVIDER_CHAIN=isbndb,openlibrary,google_books`.
3. New rate limiter for ISBNdb in `src/lib/server/ratelimit.ts`
   matching their tier.
4. Manual override path stays: rows with `description_provider='manual'`
   skip refetch entirely.

**Risk envelope:** low. The schema, types, and provider-switching
abstraction are already in place (Q3 design decisions).

---

## 5. AI-quality / takedown-scrub admin path

**Trigger:** first publisher takedown request, OR first time we want
to manually replace a wrong-edition blurb. (Spec mentions
`do_not_refetch_description` column — added preemptively in the
catalog plan migration.)

**Why deferred:** zero current demand. Schema is ready; UI is not.

**Scope of follow-up plan:**

1. Admin-only page `/app/admin/catalog` (gated on a
   `is_admin: boolean` profile flag, which we'd need to add to the
   `profiles` table — separate small migration). Lists `book_catalog`
   rows with search by ISBN / title.
2. Per-row actions:
   - **Scrub description**: sets `description = NULL`, `description_raw
= NULL`, `description_provider = NULL`, `do_not_refetch_description
= true`. Future fetcher runs leave description fields alone.
3. Audit log: append-only table `catalog_admin_actions` with
   `(admin_user_id, isbn, action, before_jsonb, after_jsonb, created_at)`.
4. The fetcher already respects `do_not_refetch_description` — verified
   by Task 10 fetcher logic. No fetcher changes needed.

**Risk envelope:** low. Self-contained, behind admin gate.

---

## 6. Public / share / embed cover URLs (anon role)

**Trigger:** when a public-facing share or embed page is built that
needs to render covers without an authenticated session.

**Why deferred:** spec's open-questions section flagged this; current
catalog work assumes every reader is authenticated. The
public-Storage-bucket pattern from
`20260412000007_create_storage.sql` + the audit doc
`20260429000008_document_cover_cache_anon_access.sql` allows the
underlying cover bytes to be served anonymously, but `book_catalog`
table reads require authentication.

**Scope of follow-up plan:**

Two options to evaluate:

(a) **Server-resolve at request time.** Public page server-side reads
`book_catalog` via service-role, returns the resolved cover URL
in the page payload. No new RLS policy. Matches the existing
transfer-page pattern.

(b) **Add anon SELECT policy on `book_catalog` for the columns needed
by public surfaces.** Probably `(isbn, storage_path,
    cover_storage_backend, title, author)` only — keep `description`
behind authenticated read. Documented audit precedent in
`20260429000008` for similarly carving anon access.

Pick (a) unless we end up with fully-static public viewers that can't
do server-side resolution.

**Risk envelope:** low. Both options preserve the documented anon
posture from the 2026-04-29 audit.

---

## 7. Continuous-warmup tuning

**Trigger:** weekly cron `/api/cron/catalog-warmup` runs for ~3 months
in production; review actual hit-rate vs cold-miss vs rate-limit-empty
metrics (cron logs the JSON shape).

**Why deferred:** numbers don't exist yet. The 100-ISBN/run cap and
`0 8 * * 1` schedule are conservative starting points; real telemetry
will tell us if they're wrong.

**Scope:**

1. Add a Supabase view `book_catalog_warmup_metrics` that aggregates
   the last N runs from cron logs (`vercel logs` or stored separately).
2. If hit rate is high but coverage is incomplete, raise the
   per-run cap. If rate-limited, raise the cron frequency or split
   into multiple cron jobs across the day.
3. Consider augmenting the candidate list:
   - Open Library subjects API for popular genres
   - Project Gutenberg top-100 for classic / public domain
   - User-aggregate ISBN list (most-uploaded ISBNs across `librito.io`
     users that are _not yet_ in catalog) — would require a
     `SELECT DISTINCT books.isbn FROM books LEFT JOIN book_catalog
USING (isbn) WHERE book_catalog.isbn IS NULL` query.

**Risk envelope:** low. Tuning, not redesign.

---

## 8. Pull-quote heuristic — fixture corpus expansion

**Trigger:** if real-world Google Books descriptions show false
positives (legitimate sentences stripped) or false negatives
(marketing cruft surviving) after ~1 month of production fetches.

**Why deferred:** the heuristic in
`src/lib/server/catalog/cleanup.ts` (Task 4) is regex-based. Without
a real corpus of production descriptions to grade it against, tuning
is guesswork. The fixture set in `tests/fixtures/marketing-cruft.ts`
is hand-authored and small.

**Scope:**

1. Capture 50-100 real Google Books descriptions from
   `book_catalog.description_raw` (only populated when fallback ran).
2. Hand-annotate the desired cleaned form for each.
3. Add as fixtures; tighten regexes; validate.
4. Re-run catalog `description` regeneration for affected rows
   (read `description_raw`, run new heuristic, write back to
   `description`).

**Risk envelope:** low. Tuning a heuristic with reversible writes
(`description_raw` is preserved exactly to enable this).

---

## 9. Cover storage migration — Supabase → Cloudflare retroactive

**Trigger:** if `librito.io` runs on Supabase Storage backend during
pre-launch and crosses the Free-tier 1GB or 5GB egress threshold,
prompting a flip to `COVER_STORAGE_BACKEND=cloudflare-images`. Existing
rows have `cover_storage_backend='supabase'`; they keep working
(the backend abstraction reads per-row), but we'd want to migrate
them so the Supabase bucket can be drained.

**Why deferred:** decision (per session brainstorm) was to start with
Supabase Storage on Free tier and flip to Cloudflare when needed. If
the flip happens before we cross the limit, this entire follow-up
becomes moot.

**Scope of follow-up plan:**

1. One-shot script `scripts/migrate-cover-storage-to-cloudflare.ts`:
   - Iterate `SELECT id, storage_path FROM book_catalog WHERE
cover_storage_backend = 'supabase' AND storage_path IS NOT NULL`.
   - For each: download bytes from Supabase Storage public URL,
     upload to Cloudflare Images via `uploadCover()`, update the row
     to `(storage_path = <cf-id>, cover_storage_backend =
'cloudflare-images')`.
   - Idempotent: re-running over already-migrated rows skips.
   - Paces against Cloudflare Images upload limit (1k/min on the
     standard tier).
2. Once migrated, manually purge the Supabase `cover-cache` bucket.

**Risk envelope:** low. Read-only on Supabase; writes only to
Cloudflare + DB; no user-visible interruption (URLs are constructed
per-row at read time).

---

## 10. Rename `cover_cache_pkey` index → `book_catalog_pkey`

**Trigger:** the next migration that touches `book_catalog` for any
other reason. Don't churn migration history just for this.

**Why deferred:** cosmetic only. PostgreSQL preserves index and
constraint names through `ALTER TABLE ... RENAME`, so the primary
key index on `book_catalog` is still named `cover_cache_pkey` after
the 2026-05-02 rename migration. Doesn't affect query planning,
RLS, or any code that references the table — code references go
through SQL relation names, not index names.

**Scope:** one line in the next book_catalog migration:

```sql
ALTER INDEX cover_cache_pkey RENAME TO book_catalog_pkey;
```

**Risk envelope:** zero. Index rename is metadata-only.

---

## 11. Convert text-with-CHECK columns to Postgres enums

**Trigger:** any future migration that touches `book_catalog`'s
constraint set, OR if the `Omit<Generated, ...> & { narrow types }`
pattern in `src/lib/server/catalog/types.ts` proves brittle.

**Why deferred:** three columns shipped as `text` with CHECK
constraints rather than Postgres enums:
`cover_storage_backend` (`'cloudflare-images' | 'supabase'`),
`description_provider` (`'openlibrary' | 'google_books' | 'manual'`),
`cover_source` (`'openlibrary_isbn' | 'openlibrary_search_isbn' |
'openlibrary_search_title' | 'google_books'`).

`supabase gen types typescript` widens `text` columns to `string |
null` regardless of the CHECK predicate. The current workaround in
`types.ts` uses `Omit<Generated, '<col>' | ...> & { <col>: NarrowType
| null }` to re-narrow at the type layer. Functional, documented in
CLAUDE.md, but non-obvious for future contributors.

Postgres enums would preserve the literal unions automatically — no
Omit-intersect dance, no type-vs-DB drift. Trade-off: adding a new
enum value requires `ALTER TYPE ... ADD VALUE`, which Postgres allows
but with constraints (e.g., cannot be used in the same transaction
that adds it; cannot be removed once added without recreating the
type). CHECK constraints are easier to amend.

**Scope of follow-up plan:**

1. New migration `<date>_convert_book_catalog_text_to_enums.sql`:

   ```sql
   CREATE TYPE cover_storage_backend AS ENUM ('cloudflare-images', 'supabase');
   ALTER TABLE book_catalog
     ALTER COLUMN cover_storage_backend TYPE cover_storage_backend
     USING cover_storage_backend::cover_storage_backend;
   -- and same for description_provider, cover_source
   ```

   Each conversion drops the matching CHECK constraint that was added
   in `20260502000001`.

2. Run `npm run gen:types` — generated `src/lib/types/database.ts` now emits
   narrow literal unions natively.

3. Refactor `src/lib/server/catalog/types.ts` to drop the
   Omit-intersect workaround. `BookCatalogRow` becomes a clean
   intersection extending `Generated` (still discriminated on
   `storage_path` per fix #5).

4. CLAUDE.md Database Schema section: remove the Omit-intersect
   documentation (the gen-types output is now self-documenting).

5. Verifications:
   - `supabase db reset --local` succeeds.
   - `npm run check` clean.
   - Full vitest suite green.
   - The CI drift gate still passes.

**Trade-off note:** the Omit-intersect workaround is fine in
practice; this follow-up exists as a cleanup, not a fix. If we ever
want to add a fourth `cover_source` value (e.g., a paid aggregator
like ISBNdb per follow-up #4), the enum approach forces an
ordered ALTER TYPE migration in the same PR as the new code. CHECK
columns let the new value land alongside the consuming code in any
order. Pick whichever pattern matches the future workflow.

**Risk envelope:** low. The DDL is atomic; values are stable; no
data loss path.

---

## 12. Loosen `production-deploy.yml` drift-check trigger

**Trigger:** if a future incident shows generated db types drift in
production without the gate firing — likely scenarios: manual schema
edits via Supabase Studio, hand-edited types file, Supabase CLI
version bump that changes gen output formatting.

**Why deferred:** the current chain
(`changes` → `migrate` → `drift-check`) gates `drift-check` on
`needs.migrate.result == 'success'`. `migrate` only runs when
`supabase/migrations/**` changes in the PR. Result: `drift-check`
silently skips on any push-to-main that doesn't include migration
files. Acceptable today because (a) migration-smoke runs gen-types
on every PR (PR-time gate per audit fix #26), and (b) production
schema doesn't change without a migration push under normal flow.
But the gate has holes.

**Scope of follow-up plan:**

Loosen the condition in `.github/workflows/production-deploy.yml`:

```yaml
drift-check:
  if: |
    always() &&
    (needs.migrate.result == 'success' || needs.migrate.result == 'skipped')
  needs: [migrate]
```

This makes `drift-check` run on every push-to-main regardless of
whether migrations changed. `--project-id <prod-ref>` already
queries the live production schema, so the check is meaningful even
when local migrations didn't move.

**Risk envelope:** low. Worst case the loosened gate fails on a PR
that didn't intend to touch types — but that failure is correct
(types ARE drifted, the PR just didn't notice). One extra CI
minute per push to main.

---

## Process notes

- This file lives in `librito-io/web` (the implementation repo) so
  follow-ups travel with the code.
- Items graduate to `docs/superpowers/specs/<date>-<topic>-design.md`
  and `docs/superpowers/plans/<date>-<topic>-implementation-plan.md`
  when worked on (matching the existing pattern in this repo).
- Once an item ships, delete its section from this doc; don't keep
  archeology — `git log` is authoritative. (Per CLAUDE.md PR/commit
  convention.)
