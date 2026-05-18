# Seeding `book_catalog` (operator workflow)

Set `CRON_SECRET` locally (from Vercel env, since it's marked Sensitive — paste directly):

    export CRON_SECRET="<paste-from-vercel>"

Prepare an ISBN list as JSON:

    echo '{"isbns": ["9780743273565", "9780451524935"]}' > /tmp/seed.json

Trigger:

    curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
      -H "Content-Type: application/json" \
      -d @/tmp/seed.json \
      https://librito.io/api/cron/catalog-warmup

Each call processes ≤100 ISBNs (MAX_PER_RUN cap) and respects the 80/5min Open Library rate-limit budget. For larger seed lists, split + loop:

    for chunk in chunks/*.json; do
      curl -X POST ... -d @"$chunk" ...
      sleep 300
    done

Pre-launch warmup of ~3k ISBNs takes ~30 invocations + ~2.5h elapsed (mostly rate-limit pacing).

## Resetting `book_catalog` rows for re-resolve

Use this when forcing a re-resolve after a CF Images delete, a code change
that should re-fetch covers, or a post-PR backfill batch. The `WHERE`
clause varies by case (`isbn IN (...)`, `image_sha256 = '...'`, etc.); the
`SET` clause is the canonical reset.

```sql
UPDATE book_catalog
SET storage_path             = NULL,
    cover_storage_backend    = NULL,
    image_sha256             = NULL,
    cover_source             = NULL,
    cover_max_width          = NULL,
    cover_aspect             = NULL,
    cover_bytes_per_pixel    = NULL,
    gb_pdf_available         = NULL,
    gb_viewability           = NULL,
    gb_image_link_tiers      = NULL,
    description              = NULL,
    description_raw          = NULL,
    description_provider     = NULL,
    do_not_refetch_description = false,
    last_attempted_at        = '2000-01-01',
    attempt_count            = 0
WHERE isbn IN ('9780593135228');
```

Why each field clears:

- `storage_path` / `cover_storage_backend` / `image_sha256` —
  positive-cache discriminant. NULL pair → row treated as negative
  cache; the partial unique index on (`isbn`) still matches so the
  re-resolve upserts in place.
- `cover_source` / `cover_max_width` — let the resolver pick the
  source / width fresh from the new chain.
- `cover_aspect` / `cover_bytes_per_pixel` / `gb_pdf_available` /
  `gb_viewability` / `gb_image_link_tiers` — audit columns (plan
  2026-05-18). Cleared so the re-resolve records fresh values rather
  than carrying stale snapshots from the prior resolve.
- `description` / `description_raw` / `description_provider` — clear
  in lockstep so `enrichDescriptionWithGoogleBooks` re-runs (it
  short-circuits when `metadata.description` is truthy).
- `do_not_refetch_description = false` — **required.** Without this,
  a row that previously had the takedown flag set keeps it on
  re-resolve, and GB description enrichment silently skips
  (issue #206, watch for `catalog_description_skipped_takedown_flag`
  in logs).
- `last_attempted_at = '2000-01-01'` + `attempt_count = 0` — clear
  the 30-day negative-cache TTL so the next read triggers resolve.

For `image_sha256`-keyed resets (e.g. the GoogleBooks placeholder sha
on issue #207, `3efa8c43e5b4348f303a528c81adf435f0111ea752fe9f0f6241478b60987fa6`),
replace the WHERE clause with `WHERE image_sha256 = '<sha>'` and
delete the matching CF Images object so the next POST re-uploads.

After the SQL, POST the same ISBNs to the warmup cron above to drive
the resolve.

## Catalog cover audit (issue #209/#211 / plan 2026-05-18)

The `book_catalog` table carries five audit columns populated on every
resolve since plan 2026-05-18:

- `gb_pdf_available BOOLEAN` — GoogleBooks `accessInfo.pdf.isAvailable`
  at resolve time. NULL when GB was not fetched.
- `gb_viewability TEXT` — `accessInfo.viewability`.
- `gb_image_link_tiers TEXT[]` — keys present in `volumeInfo.imageLinks`.
- `cover_aspect NUMERIC(5,3)` — height / width of accepted bytes.
- `cover_bytes_per_pixel NUMERIC(7,5)` — byte_count / (w \* h).

### Validating the pdf.isAvailable filter

"Did the filter introduce regressions?" — count GB-source rows where the
filter would have accepted bytes that earlier produced bad covers:

```sql
SELECT COUNT(*) FILTER (WHERE gb_pdf_available IS TRUE) AS gb_kept,
       COUNT(*) FILTER (WHERE gb_pdf_available IS FALSE) AS gb_filtered,
       COUNT(*) FILTER (WHERE cover_source = 'google_books') AS gb_accepted,
       COUNT(*) FILTER (WHERE cover_source = 'openlibrary_isbn_direct') AS ol_direct_accepted
FROM book_catalog
WHERE fetched_at > now() - interval '30 days';
```

Healthy expected ratios at steady state:

- `gb_filtered` / (`gb_kept` + `gb_filtered`) ~ 10–20% (GB has a long
  tail of limited-preview volumes; this is the failure-class catch rate).
- `ol_direct_accepted` should be positive — confirms the new tier wins
  cases the old chain missed.

### Sampling suspicious accepted covers (Sentry-equivalent SQL)

```sql
SELECT isbn, google_volume_id, gb_viewability, gb_image_link_tiers,
       cover_max_width, cover_aspect, cover_bytes_per_pixel, fetched_at
FROM book_catalog
WHERE cover_source = 'google_books'
  AND cover_bytes_per_pixel < 0.05
ORDER BY fetched_at DESC LIMIT 50;
```

Cross-check visually via Cloudflare Images dashboard (image ID = `storage_path`).

### Post-deploy operator follow-up

1. **Re-resolve the two recoverable bad ISBNs** (PR-of-this-plan
   verification). Use the canonical reset SQL above with
   `WHERE isbn IN ('9781668053379', '9781668236512')`. Delete the CF
   Images objects with the prior shas (see Cloudflare dashboard), then
   POST `/api/cron/catalog-warmup` with
   `{"isbns":["9781668053379","9781668236512"]}` and `Authorization:
Bearer $CRON_SECRET`.

   Expected outcome: Apple in China (9781668053379) resolves via
   `openlibrary_isbn_direct` or falls through to a clean negative-cache;
   Annie Bot likewise.

2. **Delete seven known-orphan CF objects** (pre-#214 victims, no
   `book_catalog` row exists for them). Use the Cloudflare Images
   dashboard ID delete:
   - `9bee8f5f7828c2b9f185e5e4120d11fa1c9cdb1553c13311eb531b2f9e12406d`
   - `146f0c262e4aa01c48e80b9e4863a2523bbd7761b1b00dd2691271dc009e1903`
   - `dbc4f7345abab76e846da038fc087d7c1ae77b250136f907e8babaac69c7c838`
   - `b98ce9f91bdad1f3762d5e355fb95cb26d6d2f06b810ed50ceb5e1d410b2a9ed`
   - `3025799877f5b0e10c79f55d1ed7d139fa5e8906c4d17974b7f80499c51d3c51`
   - `ccdf5ff32156b28f937b80e9d124ad06f55df1e0c71f1a51ba427650b6dac53b`
   - `16f026e5f7b14d6c80fc1a8a3b77735141f96b131295ba7c5b18c7b51689f841`

   None of these are referenced from `book_catalog` so deletion is safe.

3. **Sample audit query at 7-day and 30-day post-deploy**: run the
   "Validating the pdf.isAvailable filter" query above. If
   `gb_filtered` ratio drifts above ~30%, the filter may be too
   aggressive — review the bad bucket and consider relaxing.
