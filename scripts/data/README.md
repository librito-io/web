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
