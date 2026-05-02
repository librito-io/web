# scripts/data — catalog seed inputs

`seed-isbns.json` is a flat array of ISBN-13 strings. It is consumed by
`scripts/seed-catalog.ts`, which calls `resolveIsbn` for each entry,
respecting the catalog rate-limit budgets (80 req / 5 min Open Library,
800 req / day Google Books).

## Sources

1. NYT Books API current bestseller lists (Hardcover Fiction, Hardcover
   Nonfiction, Trade Paperback, Children's Middle Grade — top 10 of each,
   pulled weekly for the past year via the NYT API).
2. Open Library subject pages for high-volume genres
   (`/subjects/fantasy.json?limit=100&sort=popular`, etc.).
3. Project Gutenberg's top 100 downloads for classic / public-domain titles.

## Format

```json
["9780743273565", "9780451524935", "9780062316097"]
```

ISBN-10 entries are auto-converted by `canonicalizeIsbn` so either form is fine.

## Operator workflow

```bash
# 1. Drop ISBNs into seed-isbns.json
# 2. Set production env locally:
export PUBLIC_SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
export UPSTASH_REDIS_REST_URL=...
export UPSTASH_REDIS_REST_TOKEN=...
export COVER_STORAGE_BACKEND=cloudflare-images
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_IMAGES_API_TOKEN=...
# 3. Run the script
npm run seed:catalog
```

The script is idempotent — re-running over an existing seed list skips
already-cached ISBNs in `book_catalog` (positive-cache hit short-circuits).
