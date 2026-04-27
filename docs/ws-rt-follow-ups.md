# WS-RT Follow-Up Work

Items deliberately deferred from the WS-RT branch (`feat/ws-rt-realtime-token-tombstones`). Each is a separate, scoped PR — none gate the WS-RT merge.

Branch context:

- WS-RT shipped: notes soft-delete + tombstones in `/api/sync`, `/api/realtime-token` JWT mint, Realtime publication on `notes` (and `book_transfers` via the split migration `20260426000003`), 30-day pg_cron GC for trashed notes, layered per-device + per-user rate limit on token mint, `authErrorResponse()` helper.
- Pre-launch posture (single dev, ~0 users). Items below are surfaced now so they don't get lost; none are blocking.

---

## 1. Replace `as unknown as XRow[]` casts in `src/lib/server/sync.ts`

**Where:** `src/lib/server/sync.ts:509,520,529,596` (and any pre-WS-RT siblings)

**Problem:** Supabase response data is cast through `unknown` to a hand-written row type. Loses both the `data | null` discriminator and any compile-time check that the SELECT shape matches the row type. The branch added the third instance; this is now an established anti-pattern across the file.

**Recommended fix:** Use `PostgrestResponseSuccess<T>` / `PostgrestSingleResponse<T>` from `@supabase/supabase-js` and parameterize each `.from("table").select<…>(...)` query so the row type flows naturally. Where a hand-typed row is unavoidable (e.g. join shapes), narrow once via a type guard rather than `as unknown as`.

**Scope:** All call sites in `src/lib/server/sync.ts`. Probably touches `src/lib/server/transfer.ts` and `src/lib/server/pairing.ts` for consistency.

**Why deferred:** Touches files outside WS-RT scope; introducing it into WS-RT would muddy archeology.

---

## 2. Batch the per-row soft-delete UPDATEs in `processSync`

**Where:** `src/lib/server/sync.ts:395-414`

**Problem:** `Promise.all(allDeletes.map(...))` issues one UPDATE per soft-deleted highlight. The validator caps `deletedHighlights` at 500 _per book_, with no global cap. Worst case at the documented payload limit: ~25k Postgres round-trips per sync.

**Recommended fix:** Collapse into a single UPDATE keyed by `(book_id, chapter_index, start_word, end_word)` IN-tuple per book, or one batch UPDATE FROM (VALUES ...). Add a global cap on the validator to bound the IN-list size.

**Scope:** `src/lib/server/sync.ts` + matching test in `tests/lib/sync.test.ts` covering large-batch correctness. Possibly a validator change with new error code.

**Why deferred:** Pre-existing pattern. Out of WS-RT scope. At pre-launch scale, this is theoretical.

**Trigger to revisit:** Sync p95 regression, or any user reporting a sync-deletion timeout. Re-evaluate when active fleet > 100 devices.

---

## 3. Behavior-level migration tests via Supabase local

**Where:** `tests/lib/migration-*.test.ts`

**Problem:** Every migration test in the project is a string-match (`expect(SOURCE).toMatch(/...sql.../)`). Catches typos; misses semantic regressions. A future migration could `ALTER PUBLICATION supabase_realtime DROP TABLE public.notes` after the WS-RT migration ran and the tests would still pass.

**Recommended fix:** Add a separate test suite (`tests/integration/`) that boots `supabase start`, runs `supabase db reset`, and asserts behavior — `INSERT into notes`, soft-delete via UPDATE, `SELECT FROM cron.job WHERE jobname = 'empty-trashed-notes'`, etc. Gate by env (`INTEGRATION=1`) so the unit suite stays fast.

**Scope:** New test harness, CI job, docs in CLAUDE.md.

**Why deferred:** Infrastructure investment, not a per-PR concern. Best done once at the start of a "harden the schema" pass.

---

## 4. Realtime JWT revocation policy

**Where:** `src/lib/server/realtime.ts` (documented trade-off)

**Problem:** `mintRealtimeToken` issues a 24h ES256 JWT that Supabase Realtime evaluates statelessly. Bearer revocation (`devices.revoked_at`) propagates to `/api/sync` immediately but does not invalidate outstanding Realtime tokens. A compromised device gets up to 24h of read access to its user's `notes` and `book_transfers` Realtime stream after revocation.

**Recommended fix (in priority order):**

1. Drop TTL to 1h, expose a refresh endpoint (`POST /api/realtime-token/refresh` reusing the same auth+ratelimit). Caps revocation latency at 1h.
2. ~~Add a `kid` (key ID) header~~ — done as part of the asymmetric-JWT migration (`2026-04-27-jwt-asymmetric-migration` handover). Rotation runbook still TODO; see item 8.
3. Maintain a `revoked_jti` set in Redis and front Realtime with a custom auth proxy. Architectural shift; abandons "use Supabase Realtime directly".

**Scope:** Mostly `src/lib/server/realtime.ts` + new refresh route + firmware coordination (firmware needs to know to refresh).

**Why deferred:** Threat model is single-user, read-only. Acceptable today. Re-evaluate when (a) multi-user devices ship, (b) a security audit forces it, or (c) a compromise scenario surfaces.

---

## 8. ES256 signing-key rotation runbook

**Where:** `src/lib/server/realtime.ts`, env var `LIBRITO_JWT_PRIVATE_KEY_JWK`, Supabase Dashboard → Project Settings → JWT signing keys.

**Problem:** Standby-key migration (2026-04-27) ships one keypair imported as a Supabase standby key. No documented procedure to rotate `LIBRITO_JWT_PRIVATE_KEY_JWK` if it leaks or for routine hygiene.

**Recommended procedure (when needed):**

1. Generate a fresh ES256 keypair:
   ```bash
   supabase gen signing-key --algorithm ES256
   ```
   Save the JWK privately (1Password). Note the new `kid`.
2. Supabase Dashboard → Project Settings → JWT signing keys → "new standby key" → import the new JWK as a second standby. Both old and new standby kids are now in the project's JWKS.
3. Wait one Realtime-cache window (≥20 minutes per Supabase docs: 5-min throttle + 10-min edge cache + ~10-min client cache).
4. Set `LIBRITO_JWT_PRIVATE_KEY_JWK` in Vercel Production env to the **new** JWK. Trigger a redeploy. New mints sign with the new kid; in-flight tokens minted with the old kid still verify against the still-published old standby.
5. Wait one access-token TTL (`REALTIME_TOKEN_TTL_SECONDS = 24h`) for in-flight tokens to expire.
6. In the Supabase Dashboard, move the old standby key Standby → Revoked → delete. JWKS now publishes only the new kid.

**Rollback:** If step 4 introduces a regression, set `LIBRITO_JWT_PRIVATE_KEY_JWK` back to the old JWK and redeploy. Both kids are still in JWKS until step 6 — round-trip is free.

**Scope:** No code changes (the runbook drives env + dashboard only). Codify as a one-shot script in `scripts/rotate-realtime-key.sh` if rotations become routine.

**Trigger:** Suspected key leak, scheduled annual rotation, or staff turnover.

---

## 5. Structured logging with request correlation IDs

**Where:** All `console.info` / `console.error` calls in `src/routes/api/*` and `src/lib/server/*`

**Problem:** Logs use ad-hoc `console.info(eventName, { …fields })`. Hard to correlate a single request across multiple log lines (auth → ratelimit → handler → error). At any meaningful traffic, this becomes a debugging blocker.

**Recommended fix:** Adopt a lightweight structured logger (`pino` is the obvious pick — small, fast, JSON-by-default, plays well with Vercel log drains). Generate a `requestId` in `hooks.server.ts`, expose via `event.locals`, attach to every log line. Format: `{ ts, level, requestId, event, ...fields }`.

**Scope:** New dep, new `src/lib/server/log.ts`, edit every existing `console.*` call in server code.

**Why deferred:** Touch-everything refactor. Better as a single PR after WS-RT lands. No functional impact at pre-launch traffic.

---

## 6. Clean up redundant `mockResolvedValueOnce` in realtime-token tests

**Where:** `tests/routes/realtime-token.test.ts` happy-path tests

**Problem:** Tests still call `limitMock.mockResolvedValueOnce({ success: true, ... })` even though `beforeEach` now sets a `success: true` default via `mockResolvedValue`. The `Once` calls are consumed first then fall through to defaults — correct, but redundant noise.

**Recommended fix:** Remove the redundant per-test once-calls. Keep only the explicit `mockResolvedValueOnce({ success: false, ... })` overrides where the test is actually asserting denial.

**Scope:** `tests/routes/realtime-token.test.ts` only. ~5 line cleanup.

**Why deferred:** Cosmetic, zero behavior change.

---

## 7. (Optional) Revisit `book_transfers` REPLICA IDENTITY FULL when WS-C lands

**Where:** `supabase/migrations/20260426000003_enable_realtime_book_transfers.sql`

**Problem:** Migration enables FULL replica identity on `book_transfers` to give the WS-C firmware the post-image without a SELECT. WS-C is not yet implemented. If the firmware ends up subscribing to a narrower projection, FULL is over-broad.

**Recommended fix:** Once WS-C ships, audit the actual subscriber. If it only consumes `(id, status, last_error)`, switch to `REPLICA IDENTITY USING INDEX` on a narrower index. Trade-off: `REPLICA IDENTITY FULL` is "always works"; the index variant is leaner WAL but breaks if the index is dropped.

**Scope:** New migration, no app code change.

**Why deferred:** Premature optimization until WS-C exists.

---

## Owner / cadence

Solo-dev project; these are self-assigned. Suggested cadence:

- Items 1, 6: bundle into a "post-WS-RT cleanup" PR within ~2 weeks of merge.
- Item 5: schedule when traffic warrants (or before public launch — better debuggability is a launch prerequisite).
- Items 2, 3, 4, 7: re-evaluate at the launch-readiness review. Open one tracking issue per item then.

When in doubt: don't preemptively burn a weekend. Wait for the trigger condition each item names.
