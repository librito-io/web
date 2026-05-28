# QStash catalog resolve queue — operator runbook

Durable runbook for cutting `librito.io` over to QStash for catalog cold-miss resolves, and for operating the queue post-cutover.

## When this applies

- Cutover to queue mode (one-time, after PRs 1-4 merged + deployed).
- Provisioning / rotation of QStash credentials.
- DLQ inspection + manual re-queue (operational, ongoing).
- Revert to inline mode (rollback).

## Pre-flight checks

- [ ] PR1, PR2, PR3, PR4 all merged to `main` and deployed via the production-deploy workflow.
- [ ] Sentry shows no `catalog.queue.publish_failed` events from the inline path (would indicate the code is already trying QStash with empty env — should never happen, but worth a glance).
- [ ] Confirm `/api/queue/catalog-resolve` exists on production: `curl -i https://web-ten-mocha-59.vercel.app/api/queue/catalog-resolve -X POST` should return `500 server_misconfigured` (signing keys unset) — proves the route is live, just not configured.

## One-time cutover

### Step 1: Create QStash project + queue

1. Log in at [console.upstash.com](https://console.upstash.com/).
2. Create a new QStash project (or reuse an existing one).
3. Create a queue named `catalog-resolve`. Parallelism is set per-publish by `flowControl` — leave the queue's parallelism config alone.
4. Enable DLQ on the queue.
5. Note from the project dashboard:
   - `QSTASH_TOKEN` (publisher auth)
   - `QSTASH_URL` (region endpoint — e.g. `https://qstash-eu-central-1.upstash.io` for EU tenants). Visible on the project page under "Quick Start" / region header. SDK default is the global `https://qstash.upstash.io`; a region-tenant token routed to global returns 401 "invalid token" (see "Common failures").
   - `QSTASH_CURRENT_SIGNING_KEY`
   - `QSTASH_NEXT_SIGNING_KEY`

### Step 2: Set Vercel env vars (production only)

For each variable below: `vercel env add <NAME> production` (or via the Vercel dashboard → Project Settings → Environment Variables). Mark each as **Sensitive**.

- `QSTASH_TOKEN` — from QStash dashboard. Mark **Sensitive**.
- `QSTASH_URL` — region endpoint (e.g. `https://qstash-eu-central-1.upstash.io` for EU tenants). The SDK default is `https://qstash.upstash.io` (global); a region-tenant token routed to global returns 401 "invalid token". Producer + DLQ-drain pass this as `baseUrl` to `QStashClient`. Required for both code-paths to publish. Mark **Encrypted** — public Upstash endpoint, not a secret; Encrypted lets `vercel env pull` read it back for drift checks (the value that just bit us would have been visible).
- `QSTASH_CONSUMER_URL` — `https://web-ten-mocha-59.vercel.app/api/queue/catalog-resolve` (pre-launch) or `https://librito.io/api/queue/catalog-resolve` (post-DNS-flip). Consumer-side also reads this var to bind the QStash signature verification to the publisher-signed URL — set on BOTH the producer-runtime AND the consumer-runtime (same Vercel project, same env). Mark **Sensitive**.
- `QSTASH_CURRENT_SIGNING_KEY` — from QStash dashboard. Mark **Sensitive**.
- `QSTASH_NEXT_SIGNING_KEY` — from QStash dashboard. Mark **Sensitive**.

> **Verify the four secret vars are Sensitive and `QSTASH_URL` is Encrypted.**
>
> ```
> npx vercel env ls -F json production \
>   | jq '.envs[] | select(.key | startswith("QSTASH_")) | { key, type }'
> ```
>
> Expected: `QSTASH_URL` is `"encrypted"`; the other four (`QSTASH_TOKEN`, `QSTASH_CONSUMER_URL`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`) are `"sensitive"`. Any mismatch: delete + re-add with the correct type.

### Step 3: Trigger a deploy

```
gh workflow run production-deploy.yml -R librito-io/web
```

Or push any trivial change to `main`. The producer flips to the QStash path on the next production request after deploy.

### Step 4: Smoke monitor for 24h

Watch:

- **Sentry** for new `catalog.queue.publish_failed` events (any in the first hour are red flags). The single `catalog.queue.resolve_failed` is fine — that's normal upstream failure landing in DLQ.
- **Admin UI** `/app/admin/catalog/<any-id>` → DLQ archive section. Expect zero rows immediately post-cutover; expect single-digit entries within 24h as the queue catches the long tail of slow upstream resolves.
- **Vercel logs** filter on `event=catalog.queue.published` — should show `path: "qstash"` (not `path: "inline"`).

## Operational tasks

### Inspect DLQ for a specific catalog row

`/app/admin/catalog/<id>` → "DLQ archive" section. Lists matching rows ordered by `archived_at DESC`, capped at 50. Older rows accessible via Supabase Studio query on `catalog_dlq_archive`.

### Manual re-queue

Use the existing requeue action on the catalog detail page. Select the fields to re-resolve; submit. The action:

1. Calls `admin_apply_action(..., 'requeue', { fields })` — resets per-field state.
2. Calls `scheduleCatalogResolveIfAllowed(SERVICE_USER_ID, work, { bypassUserLimit: true })` — publishes to QStash if the queue path is live.
3. Stamps `manually_requeued_at = now()` ONLY on the DLQ archive rows the operator actually saw (scoped via hidden form inputs carrying the loaded archive IDs). Prevents touching DLQ rows belonging to a different catalog row sharing the same ISBN during a `set_isbn` race.

Repeated re-queues against the same `book_catalog` row are safe — the resolver is upsert-based and the per-field TTL ladder gates redundant upstream calls.

### Rotate QStash signing keys

`Receiver` verifies against both `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`. Standard rotation:

1. In QStash console, rotate the signing key. The console publishes the new key as `next` and demotes the old current to `next` for a grace period — check the console for the exact sequence.
2. Update both Vercel env vars to match the console's new current + next.
3. Trigger a deploy.
4. After the grace period, repeat to drop the old key entirely.

### Adding a new tracked field — consumer-before-producer

`parseWorkPayload` rejects messages carrying a `fields[]` entry not in `TRACKED_FIELDS` (consumer-side validation). Adding a new tracked field to `src/lib/catalog/tracked-fields.ts` is therefore a two-deploy sequence in production:

1. Deploy the consumer change first — `parseWorkPayload` now accepts the new field.
2. Deploy the producer change second — `scheduleCatalogResolveIfAllowed` callers may now include the new field in published messages.

Reversing the order would land every message carrying the new field in DLQ (4xx = permanent failure). Mirrors the consumer-before-producer rule the migration itself follows. In a single-PR change the rule is moot — both sides update together. The rule kicks in when the producer-side change ships in a PR that also adds a new tracked-field literal, and the consumer side is currently behind on production.

### Revert to inline mode

Unset any of `QSTASH_TOKEN`, `QSTASH_CONSUMER_URL`, or `QSTASH_URL` in Vercel production. Trigger a deploy. The producer falls back to the inline `runInBackground` path on next request. No code rollback needed. The consumer route stays live but receives no traffic.

DLQ archive contents remain in `catalog_dlq_archive` indefinitely (audit log).

### Common failures

- **`QstashError: unable to authenticate: invalid token` (HTTP 401)** from `POST qstash.upstash.io/v2/batch` — region mismatch. The SDK default endpoint is the global `https://qstash.upstash.io`; a token issued for a region-specific tenant (e.g. EU `qstash-eu-central-1.upstash.io`) is unknown to the global endpoint and rejected. Verify `QSTASH_URL` is set on the production target and matches the project's region as shown in the Upstash console. Producer code passes this explicitly as `baseUrl` to `QStashClient`; missing the env var degrades to the inline fallback via the triplet gate in `scheduling.ts`.
- **`QstashError: unable to authenticate: invalid token` (HTTP 401)** with `QSTASH_URL` correct — paste error in `QSTASH_TOKEN`. Sensitive vars are write-only post-creation, so a one-char truncation or stray `Bearer ` prefix is invisible until first publish. Remove + re-add the var with a fresh paste from the Upstash console.

## Tier + cost notes

- QStash free tier: 1000 messages/day, max parallelism 2.
- Cost above free tier: ~$1 per 100k messages.
- See the spec § Cost projection table for projected monthly cost by active-user count.

## Reference

- Spec: `reader` repo → `docs/superpowers/specs/2026-05-28-catalog-resolve-queue-design.md`.
- Code: `src/lib/server/catalog/scheduling.ts` (producer), `src/routes/api/queue/catalog-resolve/+server.ts` (consumer), `src/routes/api/cron/catalog-dlq-drain/+server.ts` (drain).
- Failure modes the queue does NOT solve: per-source rate limits (OpenLibrary 80/5min, Google Books 800/day) still live inside the resolver. Backfill-script pacing per librito-io/web #198 is the protection layer.
