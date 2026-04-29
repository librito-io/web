# Server Helpers Audit — Bugs, Perf & CLAUDE.md Drift in `src/lib/server/` (2026-04-29)

Source-of-truth for fix work that came out of `/repo-review src/lib/server`. Each issue is a self-contained section a future session can pick up cold.

## Context

- **Trigger**: `/repo-review src/lib/server` run 2026-04-29.
- **Scope reviewed**: 10 files under `src/lib/server/` — `auth.ts`, `email.ts`, `errors.ts`, `pairing.ts`, `ratelimit.ts`, `realtime.ts`, `supabase.ts`, `sync.ts`, `tokens.ts`, `transfer.ts`. These are the device-API auth middleware, business-logic helpers, and response/rate-limit primitives consumed by every route in `src/routes/api/**`.
- **Reviewers**: 5 parallel agents (CLAUDE.md compliance, bugs/logic, security, types/perf, simplification) + main-session verification reads against current HEAD.
- **Calibration**: existing-code (stricter than branch-review). Code that has shipped and run earns trust — theoretical issues penalised.
- **Filtering**: confidence ≥ 80 surfaced as Critical/Warning. Lower scores included for completeness with explicit Skip/Verify recommendations.
- **OSS lens applied throughout**: contributor-onboarding clarity (validation duplication, magic literals, log noise) and self-host reliability (multi-device sync correctness, Host-header trust on misconfigured proxies) weighted higher than they would be in a closed-source review.

## Workflow

1. **One session per fix group** (small focused PRs squash-merge cleanly into archeology).
2. **Each session opens with** "read `docs/audits/2026-04-29-server-helpers.md`, work on issue X".
3. **Session reads the issue section + the referenced source files**, implements, tests, opens PR.
4. **Before session closes**: update the Status table here with PR link + status. Add follow-ups discovered during implementation as new sections.

## Status overview

| #   | Issue                                                                | Severity               | Score | PR                                               | Status             | Session date |
| --- | -------------------------------------------------------------------- | ---------------------- | ----- | ------------------------------------------------ | ------------------ | ------------ |
| B1  | Highlight upsert resurrects soft-deleted rows on multi-device        | Critical (bug)         | 85    | [#38](https://github.com/librito-io/web/pull/38) | merged             | 2026-04-29   |
| B2  | Pairing Redis-write-after-claimed orphans pairing on Upstash hiccup  | Warning (bug)          | 85    | [#39](https://github.com/librito-io/web/pull/39) | in review          | 2026-04-29   |
| B3  | TOCTOU race in `claimPairingCode` (read-then-update non-atomic)      | Warning (bug)          | 80    | [#39](https://github.com/librito-io/web/pull/39) | in review          | 2026-04-29   |
| B4  | `.single()` on optional re-pair lookup emits PGRST116 noise          | Warning (bug)          | 80    | [#39](https://github.com/librito-io/web/pull/39) | in review          | 2026-04-29   |
| P1  | Sync soft-delete loop = N+1 UPDATE per highlight                     | Critical (perf)        | 90    | —                                                | open               | —            |
| P2  | `createAdminClient` instantiated per request, no singleton           | Warning (perf)         | 70    | —                                                | open               | —            |
| P3  | Signed URL generation runs sequentially after sync read phase        | Warning (perf)         | 70    | —                                                | open               | —            |
| P4  | `checkPairingStatus` two sequential round-trips per poll             | Warning (perf)         | 65    | —                                                | open               | —            |
| P5  | `importJWK` runs every realtime mint; CryptoKey not cached           | Polish (perf)          | 45    | —                                                | open               | —            |
| C1  | `createAdminClient` missing explicit return type                     | Warning (cmd)          | 85    | —                                                | open               | —            |
| C2  | `failedCountResult` double-cast `as unknown as { count?: number }`   | Warning (cmd)          | 80    | —                                                | open               | —            |
| C3  | `$env/static/public` import in `realtime.ts`                         | Doc                    | 50    | —                                                | skip               | —            |
| C4  | `$env/static/private` import in `email.ts`                           | Doc                    | 30    | —                                                | skip               | —            |
| S1  | `.or(\`device_id.eq.${deviceId},…\`)` raw interpolation              | Warning (sec, defense) | 40    | —                                                | open               | —            |
| S2  | Welcome email `siteUrl` derived from `url.origin` (Host header)      | Warning (sec)          | 60    | —                                                | open               | —            |
| S3  | 6-digit pairing code brute-force surface                             | Doc                    | 35    | —                                                | skip + document    | —            |
| S4  | `userEmail` exposed by `checkPairingStatus` to any `pairingId`       | Doc                    | 30    | —                                                | skip               | —            |
| L1  | Pairing TTL literal repeated 3 places                                | Polish                 | 70    | —                                                | open               | —            |
| L2  | `_retried = false` recursion-state param exposed in signature        | Polish                 | 60    | —                                                | open               | —            |
| L3  | `validateSyncPayload` duplicates range check across two arms         | Polish                 | 65    | —                                                | open               | —            |
| L4  | Unnecessary `as number` casts after `typeof` narrowing               | Polish                 | 75    | —                                                | open               | —            |
| L5  | Validation convention split: `string \| null` vs discriminated union | Polish                 | 60    | —                                                | open               | —            |
| L6  | `transfer.ts` RPC return type cast (untyped `row.attempt_count`)     | Polish                 | 50    | —                                                | open (conditional) | —            |
| L7  | `email.ts` per-signup `console.log` noise when Resend unconfigured   | Polish                 | 65    | —                                                | open               | —            |
| L8  | `checkKidInJwks` emits same warn name for two distinct conditions    | Polish                 | 55    | —                                                | open               | —            |
| L9  | `auth.ts` `sk_device_` prefix fast-fail has no comment               | Polish                 | 40    | —                                                | open               | —            |
| L10 | `auth.ts:39` `slice(7)` magic offset for `"Bearer "`                 | Polish                 | 20    | —                                                | skip               | —            |
| L11 | `email.ts` try/catch scope wider than needed                         | Polish                 | 25    | —                                                | skip               | —            |
| L12 | `pairing.ts:86-92` `let userEmail = ""` conditional assign           | Polish                 | 15    | —                                                | skip               | —            |
| L13 | `pairing.ts:132-175` `if/else` could be `upsertDevice` helper        | Polish                 | 25    | —                                                | skip               | —            |
| L14 | `realtime.ts:104` destructured `key_ops` unused                      | Polish                 | 30    | —                                                | skip               | —            |
| L15 | `sync.ts:508-535` three near-identical `map` blocks                  | Polish                 | 25    | —                                                | skip               | —            |
| L16 | `ratelimit.ts` 8 repetitive `Ratelimit` constructors                 | Polish                 | 20    | —                                                | skip               | —            |

## Suggested PR groupings

| PR # | Issues                     | Theme                                                            | File touch surface                            |
| ---- | -------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| 1    | B1                         | Multi-device sync correctness (highlight resurrection fix)       | `sync.ts` (+test)                             |
| 2    | B2, B3, B4                 | Pairing-claim flow hardening (atomic claim + Redis ordering)     | `pairing.ts` (+test)                          |
| 3    | P1                         | Sync soft-delete RPC batch (1 migration + call site)             | new migration + `sync.ts`                     |
| 4    | C1, P2, C2                 | Server helpers CLAUDE.md drift + cheap perf                      | `supabase.ts`, `sync.ts`                      |
| 5    | P3                         | Sync read-phase signed URL parallelization                       | `sync.ts`                                     |
| 6    | P4                         | Pairing status email denormalization (1 migration + 2 sites)     | new migration + `pairing.ts`                  |
| 7    | L1, L2, L3, L4, L7, L8, L9 | Server polish bundle (mechanical refactors, log hygiene)         | multiple                                      |
| 8    | L5, L6                     | Validation convention convergence + Supabase generated types     | `transfer.ts`, `sync.ts`                      |
| 9    | S1, S2                     | Defense-in-depth (UUID guard at auth boundary, siteUrl hardcode) | `auth.ts`, `email.ts`, `routes/auth/callback` |
| 10   | P5                         | Realtime CryptoKey cache by `kid`                                | `realtime.ts`                                 |
| 11   | S3, S4, C3, C4, L10–L16    | Decisions/comments (no-change-needed audit closure)              | doc + light comments                          |

PRs 1, 2, 3 carry the bulk of correctness + perf risk; tackle in that order. PR 4 is independent and parallelisable (single-day "easy win" PR). PR 7 is a bulk simplifier — defer until after the correctness PRs land so the diff is mechanical rather than semantic. PRs 8, 9, 10 are independent.

---

# Issue B1 — Highlight upsert always sets `deleted_at: null`, resurrecting server-side deletions on multi-device sync

**Status**: merged ([#38](https://github.com/librito-io/web/pull/38))
**Score**: 85
**Severity**: Critical (data integrity)
**Suggested PR**: 1 (shipped)

## Location

- [`src/lib/server/sync.ts:354-378`](../../src/lib/server/sync.ts#L354-L378) — the `allHighlightRows` row construction + upsert.

## Why it matters

`processSync` writes every incoming highlight with an explicit `deleted_at: null` field (line 365), then `.upsert(allHighlightRows, { onConflict: 'book_id,chapter_index,start_word,end_word' })`. Supabase upsert with default `ignoreDuplicates: false` writes ALL columns in the payload on conflict.

Multi-device scenario (schema allows multiple devices per user):

1. Device A deletes highlight H, syncs `deletedHighlights: [H]`. Server soft-deletes H (`highlights.deleted_at = now`).
2. Device B (not yet synced) still has H locally and its next sync sends H in `highlights[]`.
3. Server write phase upserts H — `deleted_at: null` overwrites the timestamp. **H is resurrected.**
4. Server read phase queries `WHERE deleted_at IS NOT NULL AND updated_at > lastSynced` for `deletedHighlights[]` response — H is no longer matched (we just nulled it). Device A's deletion is silently lost; H reappears on Device A on its next sync as a fresh row.

Single-device users never trigger this because the sole device's payload is authoritative. But the schema explicitly supports multi-device per user (`devices.user_id` is many-to-one), and the OSS user base will include power users with multiple readers. The bug is silent — no error, no log line — and corrupts the deletion-propagation contract that `/api/sync` advertises.

OSS context: defaults that silently lose user data are exactly what new-installation reviewers spot first. Fix before the multi-device path gets exercised at scale.

## Recommendation

Drop `deleted_at: null` from the row construction. Supabase upsert preserves columns omitted from the payload on conflict, so server-side `deleted_at` survives intact.

The `paragraph_breaks` column is also written as `null` when the device omits it; that field should keep the explicit `null` because the device IS authoritative for the styles/breaks of any highlight it sends. Only `deleted_at` is special — it's the one column the server owns the truth for.

## Implementation

`src/lib/server/sync.ts` — drop one line in the row construction:

```ts
return book.highlights.map((h) => ({
  book_id: bookId,
  user_id: userId,
  chapter_index: h.chapter,
  start_word: h.startWord,
  end_word: h.endWord,
  text: h.text,
  chapter_title: h.chapterTitle ?? null,
  styles: h.styles ?? null,
  paragraph_breaks: h.paragraphBreaks ?? null,
  device_timestamp_raw: h.timestamp ?? null,
  // deleted_at intentionally omitted — server owns this column.
  // Including it would resurrect server-side soft-deletes when a
  // not-yet-synced device sends back the same highlight.
}));
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] New unit test in `tests/lib/sync.test.ts`: seed a soft-deleted highlight (`deleted_at` set), call `processSync` with a payload that includes that same highlight in its `highlights[]` array, assert the DB row's `deleted_at` is unchanged afterwards.
- [ ] New unit test: same but verify the row appears in the next sync's `deletedHighlights[]` response (deletion still propagates after the no-op upsert).
- [ ] Manual: simulate two devices on one account. Device A deletes a highlight, syncs. Before Device B syncs, send Device B's full payload (still contains the highlight). Verify highlight stays deleted on next Device A sync.

## Open questions

- Does Supabase upsert with `onConflict` truly preserve omitted columns? Documented behavior per PostgREST: on conflict, only listed columns are updated. Verify locally with a 4-row reproducer in a test DB before relying on it.
- Are there any OTHER columns in the upsert payload that might have the same own-by-server semantics? `device_timestamp_raw` is device-authored; `text` / `chapter_title` / `styles` / `paragraph_breaks` are device-authored. Only `deleted_at` (and the row's own `updated_at` trigger) are server-owned. Audit complete.

## Dependencies

- Independent. Single-file change. No migration.

---

# Issue B2 — Pairing claim writes Redis token AFTER marking code claimed; Upstash hiccup permanently bricks pairing

**Status**: in review ([#39](https://github.com/librito-io/web/pull/39))
**Score**: 85
**Severity**: Warning (bug — operational)
**Suggested PR**: 2

## Location

- [`src/lib/server/pairing.ts:177-188`](../../src/lib/server/pairing.ts#L177-L188) — happy-path tail of `claimPairingCode`.

## Why it matters

Sequence today:

1. Insert/update device row.
2. `UPDATE pairing_codes SET claimed=true, user_id=$userId WHERE id=$pairingId`. (lines 178-181)
3. Return `server_error` if step 2 errored.
4. `await redis.set('pair:token:$pairingId', token, { ex: 300 })`. (lines 186-188)
5. Return success to browser.

If the Redis write at step 4 fails (transient Upstash 5xx, network blip, region failover), the function still returns `{ deviceId, deviceName }` to the browser as success, but no token reaches the device. The device polls `checkPairingStatus`, sees `claimed=true`, calls `redis.get('pair:token:...')`, receives `null`, and returns `{ error: 'code_expired' }` ([`pairing.ts:82`](../../src/lib/server/pairing.ts#L82)). The user has no recovery path:

- The code is consumed (`claimed=true`), so re-typing it fails with `already_claimed`.
- The idempotent-replay path at lines 119-129 returns `{ deviceId, deviceName }` but does NOT re-issue a token. Even if the user retries the claim, no token comes back.
- Manual recovery requires resetting `pairing_codes.claimed` via SQL.

Compounded by the missing `await redis.set(...)` error check — the write can throw and the surrounding code has no try/catch, so a thrown error propagates as a generic 500 to the browser AFTER the device row was already written and the code was already consumed.

OSS context: self-hosters running on flaky Upstash networking, free-tier quota exhaustion, or non-Upstash Redis-compatible backends will hit this within their first 100 pairings.

## Recommendation

Two options.

**Option A (preferred — invert order):** Write Redis FIRST, then mark claimed. If Redis fails, return `server_error` before the code is consumed. The window where token is in Redis but code isn't yet claimed is harmless — the device polls `claimed=false` until the next status check.

**Option B (atomic pairing of orders):** Wrap Redis write in try/catch; on Redis failure, roll back `claimed=true` to `claimed=false` and return `server_error`. More moving parts; rollback can also fail.

Option A is simpler and has a strictly narrower failure window.

## Implementation

`src/lib/server/pairing.ts` — restructure the tail of `claimPairingCode`:

```ts
// ... after device insert/update succeeds, deviceId + deviceName + token in scope

// Store plaintext token in Redis FIRST. If this fails, the pairing code
// is still un-claimed, so the user can retry without manual recovery.
try {
  await redis.set(`pair:token:${pairingCode.id}`, token, {
    ex: PAIR_REDIS_TTL_SEC,
  });
} catch (err) {
  console.error("pairing.redis_token_write_failed", {
    pairingId: pairingCode.id,
    error: String(err),
  });
  return { error: "server_error" };
}

// Now mark code as claimed. If THIS fails, the token in Redis is harmless —
// it expires in 5 min and no device can reach it without first hitting a
// claimed=true status response.
const { error: markError } = await supabase
  .from("pairing_codes")
  .update({ claimed: true, user_id: userId })
  .eq("id", pairingCode.id);

if (markError) return { error: "server_error" };

return { deviceId, deviceName };
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] New unit test in `tests/lib/pairing.test.ts`: mock Redis to throw on `set`. Call `claimPairingCode`. Assert: returns `{ error: 'server_error' }`, `pairing_codes.claimed` is still `false`, no `pair:token:*` key exists.
- [ ] New unit test: mock Supabase mark-claimed UPDATE to error. Call `claimPairingCode`. Assert: returns `{ error: 'server_error' }`, Redis key may or may not be set (acceptable since it self-expires in 5 min).
- [ ] Existing happy-path test still passes.

## Open questions

- Does the existing `tests/helpers.ts` mock Redis support throwing on `.set()`? Verify and extend if needed.
- The reordering reverses the Redis-then-DB logical order. Audit `checkPairingStatus` to confirm there's no path that sees Redis-token-without-claimed and treats it as success — there isn't (line 79 short-circuits on `!data.claimed`).

## Dependencies

- Bundles with B3 (TOCTOU) and B4 (`.single()` → `.maybeSingle()`) in PR 2. Same function, contiguous diff.

---

# Issue B3 — `claimPairingCode` reads code state then UPDATEs without atomicity; concurrent claims both pass

**Status**: in review ([#39](https://github.com/librito-io/web/pull/39))
**Score**: 80
**Severity**: Warning (bug — race)
**Suggested PR**: 2

## Location

- [`src/lib/server/pairing.ts:103-183`](../../src/lib/server/pairing.ts#L103-L183) — read at lines 105-109, claimed-check at line 119, mark-claimed UPDATE at lines 178-181.

## Why it matters

Two concurrent claim attempts for the SAME 6-digit code (e.g., user double-clicks the claim button, two browser tabs, mobile app + desktop) execute:

| Timeline | Request 1                                               | Request 2                                                                             |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| t0       | `SELECT … WHERE code = $code` → `{ claimed: false, … }` |                                                                                       |
| t1       |                                                         | `SELECT … WHERE code = $code` → `{ claimed: false, … }`                               |
| t2       | `claimed === false` → fall through                      |                                                                                       |
| t3       |                                                         | `claimed === false` → fall through                                                    |
| t4       | `INSERT INTO devices …`                                 |                                                                                       |
| t5       |                                                         | `INSERT INTO devices …` (or `UPDATE devices` if same hardware_id)                     |
| t6       | `UPDATE pairing_codes SET claimed=true …`               |                                                                                       |
| t7       |                                                         | `UPDATE pairing_codes SET claimed=true …` (succeeds — no `WHERE claimed=false` guard) |
| t8       | `redis.set(pair:token:…, token1, …)`                    |                                                                                       |
| t9       |                                                         | `redis.set(pair:token:…, token2, …)` (overwrites token1)                              |

Outcome: two device rows created (or one device updated twice), one orphaned token returned to one of the two requesters. The other requester gets a token that no longer matches `devices.api_token_hash`. Manual cleanup needed.

`pairing_codes.code` has a unique constraint, so the same code can't exist twice — but neither request fails. The race is in the read-modify-write of `claimed`, not in the row identity.

OSS context: web UIs that fire requests on every click without debouncing will trigger this. Better to be atomic at the DB layer.

## Recommendation

Replace the read-then-update with a single conditional UPDATE that returns the row if-and-only-if it transitioned `false → true`. Postgres `UPDATE … RETURNING` with a `WHERE claimed=false` predicate is atomic at row-lock level.

The pre-read for `expires_at` / `hardware_id` can stay (we still need those values to construct the device row), OR we can fold them into the conditional UPDATE's `RETURNING` clause and only run device-write if the UPDATE succeeded.

Cleaner: run device-write first, then conditional `UPDATE pairing_codes SET claimed=true WHERE id=$id AND claimed=false RETURNING id`. If 0 rows affected, another request beat us — roll back the device-write or treat the device as already provisioned by the winner. Since both requests are for the same user/hardware_id, the device row is idempotent (`UPDATE` on existing or `INSERT` of a duplicate-keyed device fails the unique constraint on `(user_id, hardware_id)` — which we'd need to verify exists in the schema).

Simplest atomic shape:

```ts
// 1. Read code (for hardware_id, expires_at, claimed-check + idempotent path).
// 2. If not claimed and not expired:
//    a. Conditional UPDATE: SET claimed=true WHERE id=$id AND claimed=false RETURNING id.
//    b. If 0 rows: another request claimed it — return { error: "already_claimed" }
//       (or fall into the idempotent path if user_id matches).
//    c. If 1 row: we won the race. Insert/update device. Write Redis. Done.
```

## Implementation

`src/lib/server/pairing.ts` — restructure `claimPairingCode` to claim first, then provision:

```ts
// After existing read + expiry/idempotent checks pass, replace the
// device-write-then-mark-claimed sequence with claim-first:

const { data: claimRow, error: claimError } = await supabase
  .from("pairing_codes")
  .update({ claimed: true, user_id: userId })
  .eq("id", pairingCode.id)
  .eq("claimed", false) // CONDITIONAL — only the first request transitions
  .select("id")
  .maybeSingle();

if (claimError) return { error: "server_error" };
if (!claimRow) {
  // Another request beat us. Fall into the idempotent replay logic if the
  // winner was the same user; otherwise reject.
  const { data: winnerCheck } = await supabase
    .from("pairing_codes")
    .select("user_id")
    .eq("id", pairingCode.id)
    .single();
  if (winnerCheck?.user_id !== userId) return { error: "already_claimed" };

  const { data: device } = await supabase
    .from("devices")
    .select("id, name")
    .eq("user_id", userId)
    .eq("hardware_id", pairingCode.hardware_id)
    .maybeSingle();
  if (!device) return { error: "already_claimed" };
  return { deviceId: device.id, deviceName: device.name };
}

// We won the race. Provision the device + write Redis (per B2 ordering).
// ... existing insert/update + Redis write
```

The `.eq("claimed", false)` on the UPDATE is the lock. PostgreSQL row locking handles concurrency; the second `UPDATE` will see the post-update state and match zero rows.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] New unit test simulating two concurrent claims for the same code: only one returns success, the other returns `already_claimed` (or the idempotent replay shape if same user).
- [ ] Existing happy-path tests still pass.
- [ ] Manual: hammer the claim endpoint with 10 concurrent same-code requests via `curl -P 10` — exactly one device row exists afterwards.

## Open questions

- Does `devices` schema enforce `UNIQUE (user_id, hardware_id)`? Worth checking — the duplicate-INSERT failure is the secondary safety net. (Recent migrations look like they do; verify in `supabase/migrations/20260412000002_create_devices_and_pairing.sql`.)
- The "fall into idempotent path" branch above does an extra round-trip to fetch winner's user_id. Could be folded into the conditional UPDATE's `RETURNING` to avoid the second query.

## Dependencies

- Bundles with B2 (Redis ordering) + B4 (`.maybeSingle()` for re-pair lookup) in PR 2. The conditional UPDATE shape changes the function structure enough that the Redis-ordering fix from B2 needs to align with the new control flow.

---

# Issue B4 — `claimPairingCode` re-pair lookup uses `.single()` instead of `.maybeSingle()`; emits PGRST116 noise on every first-pair claim

**Status**: in review ([#39](https://github.com/librito-io/web/pull/39))
**Score**: 80
**Severity**: Warning (bug — log noise + fragility)
**Suggested PR**: 2

## Location

- [`src/lib/server/pairing.ts:141`](../../src/lib/server/pairing.ts#L141) — existing-device lookup in the new-device branch.

## Why it matters

```ts
const { data: existing } = await supabase
  .from("devices")
  .select("id, name")
  .eq("user_id", userId)
  .eq("hardware_id", pairingCode.hardware_id)
  .single(); // ← throws PGRST116 on zero rows
```

When the user's device has never been paired before (the common path for first-time setup), this lookup returns zero rows. `.single()` treats zero rows as an error condition and the Supabase client logs a `PGRST116: 0 rows returned` line. The error object is destructured-away (only `data: existing` is kept), so the code falls through to `existing == null`'s `else` branch and the new-device insert runs correctly — but every successful first-pair claim emits a Supabase-client log line that looks like a real error.

Two concrete consequences:

1. Production logs are polluted with PGRST116 entries that imply "something went wrong" when nothing did. OSS contributors pattern-matching on existing log noise will miss real errors.
2. `.single()`'s exact behavior on zero rows has shifted across `@supabase/supabase-js` versions; the idempotent-replay path at line 126 already uses `.maybeSingle()` correctly. Mixing the two idioms in the same function for the same lookup pattern is a maintenance hazard.

## Recommendation

Change `.single()` to `.maybeSingle()` on line 141. This is the documented Supabase idiom for "may or may not exist". Matches line 126.

## Implementation

`src/lib/server/pairing.ts:141`:

```ts
// Before:
.single();

// After:
.maybeSingle();
```

One-token diff.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — existing first-pair test continues to pass.
- [ ] Manual: pair a brand-new device locally, tail server logs, confirm no PGRST116 line.

## Open questions

- None. Documented pattern, sibling code already uses it.

## Dependencies

- Bundles with B2 + B3 in PR 2. Trivial part of the larger pairing-flow PR; isolated commit if preferred.

---

# Issue P1 — `processSync` soft-delete loop fires N round-trip UPDATEs in `Promise.all`; saturates DB pool at 1k-user target

**Status**: open
**Score**: 90
**Severity**: Critical (perf at 1k)
**Suggested PR**: 3

## Location

- [`src/lib/server/sync.ts:395-414`](../../src/lib/server/sync.ts#L395-L414) — the `allDeletes` map.

## Why it matters

```ts
if (allDeletes.length > 0) {
  await Promise.all(
    allDeletes.map(async (del) => {
      const { error: delError } = await supabase
        .from("highlights")
        .update({ deleted_at: nowIso })
        .eq("book_id", del.bookId)
        .eq("chapter_index", del.chapter)
        .eq("start_word", del.startWord)
        .eq("end_word", del.endWord)
        .is("deleted_at", null);
      // ...
    }),
  );
}
```

Each delete is a separate UPDATE round-trip with a 4-column composite WHERE. Validation cap is 500 deletes per book × 50 books = 25,000 statements per sync request worst case. Realistic per-sync deletes are smaller (tens to hundreds), but at the project's documented 1k concurrent user target (CLAUDE.md "Scaling Target"), even 10 deletes per sync × 1k concurrent users = 10,000 concurrent UPDATEs in flight. Supabase free tier connection pool exhausts, paid tier degrades.

This is the architectural blocker the CLAUDE.md scaling target is designed to catch ("Trade-offs that fall apart at 2-10× current scale are unacceptable").

## Recommendation

Replace the loop with a single Postgres function (RPC) that takes the delete-set as JSONB and runs ONE UPDATE statement. This is the established pattern in the codebase — `increment_transfer_attempt` (used in [`transfer.ts:48-54`](../../src/lib/server/transfer.ts#L48-L54)) demonstrates the convention.

```sql
CREATE OR REPLACE FUNCTION public.soft_delete_highlights(
  p_user_id uuid,
  p_now     timestamptz,
  p_rows    jsonb  -- [{book_id, chapter, start_word, end_word}, …]
)
RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH targets AS (
    SELECT
      (e->>'book_id')::uuid       AS book_id,
      (e->>'chapter')::smallint   AS chapter_index,
      (e->>'start_word')::int     AS start_word,
      (e->>'end_word')::int       AS end_word
    FROM jsonb_array_elements(p_rows) AS e
  )
  UPDATE highlights h
     SET deleted_at = p_now
    FROM targets t
   WHERE h.user_id       = p_user_id
     AND h.book_id       = t.book_id
     AND h.chapter_index = t.chapter_index
     AND h.start_word    = t.start_word
     AND h.end_word      = t.end_word
     AND h.deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.soft_delete_highlights(uuid, timestamptz, jsonb)
  TO service_role;
```

Service-role grant only — no anon/authenticated callers, the device API path uses service_role.

## Implementation

1. New migration `<timestamp>_soft_delete_highlights_rpc.sql` with the function above.
2. Update `src/lib/server/sync.ts:395-414`:

```ts
if (allDeletes.length > 0) {
  const rows = allDeletes.map((del) => ({
    book_id: del.bookId,
    chapter: del.chapter,
    start_word: del.startWord,
    end_word: del.endWord,
  }));

  const { error: delError } = await supabase.rpc("soft_delete_highlights", {
    p_user_id: userId,
    p_now: nowIso,
    p_rows: rows,
  });

  if (delError) {
    throw new Error(`Failed to soft-delete highlights: ${delError.message}`);
  }
}
```

3. Update `src/lib/server/sync.ts` types — add the RPC signature once Supabase generated types regenerate, OR cast `as Database["public"]["Functions"]["soft_delete_highlights"]["Returns"]` at the call site.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Existing sync tests covering the soft-delete path still pass (the API contract is unchanged).
- [ ] New unit test: payload with 100 deletes across 5 books → DB shows all 100 rows soft-deleted, exactly 1 RPC call observed by mock client.
- [ ] Local: `EXPLAIN ANALYZE SELECT soft_delete_highlights(…)` against a seeded user with 100 highlights — single Update node, no per-row InitPlan, sub-ms execution.
- [ ] `npx supabase db push --dry-run` clean.

## Open questions

- The `valid_word_range` CHECK constraint (`end_word >= start_word` after PR #35) is enforced on INSERT/UPDATE — does our composite WHERE benefit from a covering index? Existing `(book_id, chapter_index, start_word, end_word)` unique index from `20260412000005_create_indexes_and_triggers.sql` should cover this. Verify.
- `p_rows` JSONB shape — should we add a comment in the migration describing the expected element schema for future contributors? Yes, recommend a `COMMENT ON FUNCTION`.

## Dependencies

- Independent. Single migration + single call-site change. Tests in `tests/lib/sync.test.ts`.
- Should land AFTER B1 (highlight resurrection fix) so the test seeds for both can share fixture work, but technically independent.

---

# Issue P2 — `createAdminClient` allocates a new `SupabaseClient` per route invocation; no module-scope memoization

**Status**: open
**Score**: 70
**Severity**: Warning (perf — incidental allocation)
**Suggested PR**: 4

## Location

- [`src/lib/server/supabase.ts:5-9`](../../src/lib/server/supabase.ts#L5-L9)

## Why it matters

`createAdminClient()` is called at the top of every device-API route handler (`+server.ts` files in `src/routes/api/**`). Each call constructs a fresh `SupabaseClient` instance with internal HTTP fetch, auth state, and PostgREST query builders — none of which are session-bound when using `service_role` with `persistSession: false`.

At 1k concurrent users syncing on 30s intervals, that's ~33 client constructions per second of pure object-allocation churn. Each instance allocates fresh closures and config objects but cannot reuse any inter-request connection pooling state at the SDK level.

The `email.ts` module already follows the correct pattern with a lazy singleton:

```ts
let resend: Resend | null = null;
function getClient(): Resend | null { ... if (!resend) resend = new Resend(...); return resend; }
```

`supabase.ts` should mirror this. Service-role client is stateless across requests (no session, no auth state) — perfect candidate for module-scope memoization.

## Recommendation

Lazy-singleton the admin client. Combines naturally with the C1 fix (missing return type) since both touch the same function signature.

## Implementation

`src/lib/server/supabase.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PUBLIC_SUPABASE_URL } from "$env/static/public";
import { SUPABASE_SERVICE_ROLE_KEY } from "$env/static/private";

let adminClient: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (!adminClient) {
    adminClient = createClient(PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}
```

The function name stays `createAdminClient` for compatibility with all call sites; behavior shifts from "construct" to "get-or-construct" transparently.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — existing tests that import `createAdminClient` indirectly should continue to pass; unit tests that mock the supabase client at the module level are not affected (they mock by replacing the import).
- [ ] Manual: spike the device API endpoint (`/api/sync` or `/api/pair/request`) with `wrk` or similar, monitor process heap allocations — should be flat per request after first warm.

## Open questions

- Does any test re-import this module expecting a fresh client per call? Audit `tests/` for `createAdminClient` references — current grep shows none.
- Vercel's per-instance hot reload semantics: on Fluid Compute (per CLAUDE.md), function instances persist across requests — singleton is correct. On a fresh cold start, the singleton is freshly initialized. No special handling needed.

## Dependencies

- Bundles with C1 (return type) + C2 (sync.ts double-cast) in PR 4. All three are server-helper "easy win" cleanup.

---

# Issue P3 — Signed URL generation runs sequentially after the read-phase Promise.all; adds N storage round-trips to the critical path

**Status**: open
**Score**: 70
**Severity**: Warning (perf at 1k)
**Suggested PR**: 5

## Location

- [`src/lib/server/sync.ts:537-544`](../../src/lib/server/sync.ts#L537-L544) — `Promise.allSettled` for `createSignedUrl` runs after the read-phase `Promise.all` resolves.

## Why it matters

The sync read phase batches 5 queries via `Promise.all` (notes, deletedNotes, deletedHighlights, transfers, failedCount). Once that resolves, `transferRows` is known and the code does a SECOND wave of parallel work:

```ts
const transferRows = (transferResult.data as TransferRow[] | null) ?? [];
const urlResults = await Promise.allSettled(
  transferRows.map((t) =>
    supabase.storage
      .from("book-transfers")
      .createSignedUrl(t.storage_path, DOWNLOAD_URL_TTL),
  ),
);
```

`createSignedUrl` is an HTTP call to Supabase Storage. Up to `MAX_PENDING_TRANSFERS = 20` per user (per [`transfer.ts:6`](../../src/lib/server/transfer.ts#L6)). At 1k concurrent users with 20 transfers each = 20,000 sequential-after-the-Promise.all calls hitting Storage, all on the critical path of the sync response.

The signed URLs are independent of the rest of the response shape — they only depend on `transferRows`, which is the output of one of the 5 parallel queries. They should be kicked off as soon as `transferResult` lands, in parallel with the synchronous mapping work for notes/deletedHighlights/deletedNotes.

## Recommendation

Use a separate `Promise` for the URL generation that consumes `transferResult` directly, rather than waiting for all 5 read-phase queries to settle first.

Cleanest restructure: extract a helper `getSignedUrlsForTransfers(transferResult)` that returns a Promise, kick it off inline with the read-phase Promise.all, and await it just before constructing `pendingTransfers`.

## Implementation

`src/lib/server/sync.ts:417-487` — add a 6th parallel branch that depends on transferResult:

```ts
// Read phase + URL generation in one parallel wave:
const transferReadPromise = supabase
  .from("book_transfers")
  .select("id, filename, file_size, storage_path, sha256")
  .eq("user_id", userId)
  .eq("status", "pending")
  .or(`device_id.eq.${deviceId},device_id.is.null`);

const urlsPromise = transferReadPromise.then(async (transferResult) => {
  if (transferResult.error) return { rows: [], urls: [] };
  const rows = (transferResult.data as TransferRow[] | null) ?? [];
  const urls = await Promise.allSettled(
    rows.map((t) =>
      supabase.storage
        .from("book-transfers")
        .createSignedUrl(t.storage_path, DOWNLOAD_URL_TTL),
    ),
  );
  return { rows, urls };
});

const [
  noteResult,
  deletedNotesResult,
  deletedResult,
  transferAndUrls,
  failedCountResult,
] = await Promise.all([
  ,
  ,
  ,
  /* notes query */ /* deletedNotes query */ /* deletedHighlights query */ urlsPromise, // returns { rows, urls } once both DB read + URL gen complete
  /* failedCount query */
  ,
]);

const transferRows = transferAndUrls.rows;
const urlResults = transferAndUrls.urls;
// ... rest unchanged
```

This collapses the second wave into the first wave's tail. The sync endpoint's effective latency drops from `max(reads) + max(urls)` to `max(reads, read+urls)`.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — existing transfer-URL-fail-fallback test still works since `Promise.allSettled` shape is preserved.
- [ ] Manual: time `/api/sync` against a seeded user with 20 pending transfers — observable latency reduction matching ~1× storage round-trip time.
- [ ] Manual: simulate a `createSignedUrl` rejection — `pendingTransfer` row falls back to no-URL form (current behavior preserved).

## Open questions

- Error handling: if `transferReadPromise` errors, should the urlsPromise's `.then` throw or return the empty shape? Current implementation returns empty — which means `transferResult.error` check downstream still triggers and the route 500s. Consider preserving the explicit error throw to match existing semantics.
- Does this restructure complicate the test mock surface? `tests/helpers.ts` mock supports chained `.from(...).select(...).eq(...)` — yes. The `.then` chaining on the promise itself is plain JS, no mock impact.

## Dependencies

- Independent. Touches only `sync.ts`. Worth landing AFTER P1 so the diff stays focused on read-phase ordering, not write-phase RPC migration.

---

# Issue P4 — `checkPairingStatus` does two sequential round-trips per poll (`pairing_codes` + `auth.admin.getUserById`); high q/s on success path

**Status**: open
**Score**: 65
**Severity**: Warning (perf)
**Suggested PR**: 6

## Location

- [`src/lib/server/pairing.ts:69-94`](../../src/lib/server/pairing.ts#L69-L94)

## Why it matters

The poll endpoint fires every 3 seconds per device (per [`ratelimit.ts:21-25`](../../src/lib/server/ratelimit.ts#L21-L25)). On the success path:

1. `SELECT claimed, expires_at, user_id FROM pairing_codes WHERE id=$id`
2. If `claimed=true`: `await supabase.auth.admin.getUserById(user_id)` — second round-trip purely to fetch `users.email`.

Two round-trips per poll. At 200 paired-but-mid-claim devices polling, that's 67 q/s into the slow `auth.admin` endpoint (which goes through gotrue, not direct Postgres).

The polling stops the moment the device receives the token, so steady-state load is bounded — but the churn during fleet rollout (e.g., 100 devices claimed in a 5-minute window during an OSS demo or workshop) hits the ceiling.

## Recommendation

Denormalize `user_email` into `pairing_codes` at claim time. One additional column write during `claimPairingCode`; one fewer round-trip per status poll forever after.

The schema change is small. The code symmetry win is bigger: `checkPairingStatus` becomes a single SELECT.

## Implementation

1. New migration `<timestamp>_pairing_codes_user_email.sql`:

```sql
ALTER TABLE public.pairing_codes
  ADD COLUMN user_email text;

COMMENT ON COLUMN public.pairing_codes.user_email IS
  'Denormalized auth.users.email at claim time. Captured by '
  'src/lib/server/pairing.ts:claimPairingCode so the device-status poll '
  'can return it in one round-trip instead of two. NULL until claimed.';
```

2. Update `src/lib/server/pairing.ts:claimPairingCode` to set `user_email` alongside `claimed=true`:

```ts
// Inside the conditional UPDATE (after B3 lands):
.update({
  claimed: true,
  user_id: userId,
  user_email: userEmail,  // ← new
})
```

`userEmail` would need to be looked up once during claim (we already trust `userId` came from the session). Single `auth.admin.getUserById` call at claim time replaces hundreds of poll-time calls.

3. Update `src/lib/server/pairing.ts:checkPairingStatus` to read `user_email` directly:

```ts
const { data, error } = await supabase
  .from("pairing_codes")
  .select("claimed, expires_at, user_email")
  .eq("id", pairingId)
  .single();

// ... existing checks
return { paired: true, token, userEmail: data.user_email ?? "" };
```

The `user_id` column stays for RLS / archival purposes.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Existing pairing tests cover the email-in-status path — verify they still pass.
- [ ] New test: claim a code, verify `pairing_codes.user_email` matches `auth.users.email`.
- [ ] `npx supabase db push --dry-run` clean.

## Open questions

- Email update propagation: if a user changes their auth email AFTER pairing but BEFORE the device status-poll completes, the denormalized value is stale. Acceptable: status-poll surface only displays the email for user confirmation at claim time, so a stale value is harmless (the user sees the email they had when they claimed).
- Should the column be NOT NULL with a default? No — remains NULL until claimed.

## Dependencies

- Independent of B-series fixes. PR 6 is sequenced AFTER PR 2 (pairing-claim hardening) only because they touch the same function and avoiding merge churn is cheaper than logical dependency.

---

# Issue P5 — `importJWK` runs every realtime token mint; CryptoKey not cached

**Status**: open
**Score**: 45
**Severity**: Polish (perf — micro)
**Suggested PR**: 10

## Location

- [`src/lib/server/realtime.ts:104-105`](../../src/lib/server/realtime.ts#L104-L105) — inside `mintRealtimeToken`.

## Why it matters

`importJWK` performs EC point validation and DER parsing for the P-256 key. Microsecond-scale per call, but called on every mint. Mint is rate-limited at 1/60s per device + 30/h per user (per [`ratelimit.ts:77-87`](../../src/lib/server/ratelimit.ts#L77-L87)), so the per-mint cost is negligible compared to the JWT signing itself.

The win is small but the change is even smaller. Cache by `kid` so rotation correctness is preserved (a future rotation that swaps `privateJwk` will produce a new `kid` and miss the cache, falling through to `importJWK` once).

## Recommendation

Module-scope `Map<string, CryptoKey>` keyed by `kid`. Lazy populate on miss.

## Implementation

`src/lib/server/realtime.ts`:

```ts
const importedKeys = new Map<string, CryptoKey>();

// Inside mintRealtimeToken, replace:
const { key_ops, ...jwkForImport } = opts.privateJwk;
const key = await importJWK(jwkForImport, "ES256");

// With:
let key = importedKeys.get(opts.privateJwk.kid);
if (!key) {
  const { key_ops, ...jwkForImport } = opts.privateJwk;
  key = (await importJWK(jwkForImport, "ES256")) as CryptoKey;
  importedKeys.set(opts.privateJwk.kid, key);
}
```

`importJWK` returns `KeyLike | Uint8Array`; for ES256 with the JWK shape used here it's always a `CryptoKey` — the cast is safe.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] New unit test: mint two tokens with the same `privateJwk` — verify the second call doesn't invoke `importJWK` again (mock or spy on `importJWK` from `jose`).

## Open questions

- Memory bound: at most one entry per active `kid`. Rotations are rare (manual via Supabase Dashboard). Map will never grow beyond ~2-3 entries.

## Dependencies

- Independent. Standalone PR or fold into PR 7 (polish bundle) — flag is reviewer's choice.

---

# Issue C1 — `createAdminClient` exported without explicit return type

**Status**: open
**Score**: 85
**Severity**: Warning (CLAUDE.md drift)
**Suggested PR**: 4

## Location

- [`src/lib/server/supabase.ts:5`](../../src/lib/server/supabase.ts#L5)

## Why it matters

CLAUDE.md "Code Style" requires:

> Explicit return types on exported functions

`createAdminClient` is exported with no annotation; TypeScript infers `SupabaseClient<any, "public", "public", any, any>` which leaks `any` into call sites. Other exported functions in the same module set (`pairing.ts`, `auth.ts`, `transfer.ts`, `errors.ts`) follow the explicit-return-type convention; `supabase.ts` is the outlier.

OSS contributors copying the pattern will replicate the omission. CLAUDE.md drift compounds quickly.

## Recommendation

Add `: SupabaseClient` import + annotation. Combines naturally with P2 (lazy singleton) since both edit the same line.

## Implementation

See P2 for the combined diff. The function-signature addition alone:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export function createAdminClient(): SupabaseClient { ... }
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean

## Open questions

- The Supabase generic params (`Database`, schema name) — should the return type be `SupabaseClient<Database>` once Supabase types are generated? Out of scope for this issue; flag as a future-only consideration once `supabase gen types typescript` is wired in.

## Dependencies

- Bundles with P2 (singleton) + C2 (sync cast) in PR 4.

---

# Issue C2 — `failedCountResult` accessed via `as unknown as { count?: number }` double-cast

**Status**: open
**Score**: 80
**Severity**: Warning (CLAUDE.md drift / type safety)
**Suggested PR**: 4

## Location

- [`src/lib/server/sync.ts:594-597`](../../src/lib/server/sync.ts#L594-L597)

## Why it matters

```ts
failedTransferCount =
  (failedCountResult as unknown as { count?: number }).count ?? 0;
```

Supabase's `.select("id", { count: "exact", head: true })` returns a typed result object with `.count: number | null` directly accessible. The `as unknown as` cast is a TypeScript escape hatch that:

1. Silences the type checker without addressing the actual mismatch.
2. Will silently return `0` if a future `@supabase/supabase-js` upgrade changes the response envelope shape — mismatch would not surface as a build failure, just as a counter that's always zero.
3. Is a copy-paste hazard. OSS contributors will pattern-match and apply the same idiom elsewhere.

## Recommendation

Drop the cast. Access `.count` directly. If TypeScript complains, narrow the result type with a typed Supabase response (e.g. `PostgrestSingleResponse<...>`) — that's the actual fix.

## Implementation

`src/lib/server/sync.ts:595-597`:

```ts
failedTransferCount = failedCountResult.count ?? 0;
```

If TS complains about `count` not being on the type, the proper narrowing is:

```ts
import type { PostgrestResponseBase } from "@supabase/postgrest-js";

// At the destructure or use site:
const failedCountResult = ...;  // type is PostgrestResponse<...>
const count = (failedCountResult as PostgrestResponseBase & { count: number | null }).count;
```

— but in practice the count is exposed on the result object directly when `head: true` is set; verify by reading the Supabase type definition in `node_modules/@supabase/postgrest-js/dist/cjs/PostgrestBuilder.d.ts` first.

## Acceptance

- [ ] `npm run check` clean — no `as unknown` left in `sync.ts`.
- [ ] `npx vitest run` clean — existing failedTransferCount tests pass.

## Open questions

- Worth running `tsc --noErrorTruncation` on the file to surface the actual inferred type at this site if the direct access is rejected.

## Dependencies

- Bundles with C1 + P2 in PR 4.

---

# Issue C3 — `realtime.ts` imports from `$env/static/public` at module scope

**Status**: skip
**Score**: 50

## Location

- [`src/lib/server/realtime.ts:2-5`](../../src/lib/server/realtime.ts#L2-L5)

## Decision

CLAUDE.md's testability note flags `$env/static/private` specifically — it cannot be imported under vitest without mocking. `$env/static/public` is a different SvelteKit virtual module: values are resolved to literals at build time, available in test environments via SvelteKit's vite plugin without mocking.

The module already follows the documented injection pattern for the sensitive part — `mintRealtimeToken` accepts `privateJwk` and `supabaseUrl` as parameters rather than reading them from `$env/dynamic/private`. `getRealtimeConnectionInfo` reads only public values that have no test-mocking burden.

No drift. Skip.

If a future contributor proposes converting this to injected parameters anyway for purity, the cost is constructor-style API churn for zero practical benefit. Document the decision in this audit and move on.

---

# Issue C4 — `email.ts` imports `RESEND_API_KEY` from `$env/static/private` at module scope

**Status**: skip
**Score**: 30

## Location

- [`src/lib/server/email.ts:2`](../../src/lib/server/email.ts#L2)

## Decision

CLAUDE.md "Code Patterns" explicitly notes:

> Modules importing `$env/static/private` (e.g., `ratelimit.ts`, `supabase.ts`) cannot be directly imported in vitest. Either mock the `$env` module with `vi.mock()` or test business logic that accepts these as injected parameters.

`email.ts` follows this pattern. The `getClient()` lazy-init guard supports the no-key test path (`getClient()` returns `null`, `sendWelcomeEmail` early-returns). The `_getResendClient` export exists explicitly for test access.

No drift. Skip.

---

# Issue S1 — `.or(\`device_id.eq.${deviceId},…\`)` interpolates raw string into PostgREST filter; defense-in-depth gap

**Status**: open
**Score**: 40
**Severity**: Warning (security — defense in depth)
**Suggested PR**: 9

## Location

- [`src/lib/server/sync.ts:480`](../../src/lib/server/sync.ts#L480)

## Why it matters

```ts
.or(`device_id.eq.${deviceId},device_id.is.null`)
```

`deviceId` originates from `authenticateDevice()` → `devices.id` (a Postgres UUID generated server-side). In practice it's always a 36-char UUID, so today there is no exploitation path — the value is type-validated by Postgres on row insert.

But:

1. The pattern is **unsafe-by-default**. `.or()` does not parameterize the string; the filter is interpolated into the PostgREST query string verbatim. PostgREST maintainers have flagged this as a category-level injection risk.
2. OSS contributors will copy the pattern. A future change that lets a user-controlled value flow into this position (e.g. accepting a `device_id` query param, or a different auth path) becomes an injection vulnerability with no obvious red flag at the point of change.
3. The defense — enforcing UUID format at the auth boundary — is one regex line.

## Recommendation

Validate that `deviceId` is a UUID at the point it leaves `authenticateDevice`. If invalid, the function returns `{ error: "invalid_token" }` (which it cannot today, since `devices.id` is always a UUID, but the guard makes the contract explicit).

Alternative: split the `.or()` into two parallel queries union'd in JS. More verbose but eliminates the interpolation entirely.

UUID validation at the boundary is preferred — it's one line and catches the entire class.

## Implementation

`src/lib/server/auth.ts` — add a UUID guard before returning the device:

```ts
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Inside authenticateDevice, before the return:
if (!UUID_RE.test(device.id) || !UUID_RE.test(device.user_id)) {
  return { error: "invalid_token" };
}
```

Both `device.id` and `device.user_id` flow into raw filter strings (the latter into `eq` filters which use a similar interpolation pattern). The guard normalizes the trust contract for both downstream consumers.

Optionally, add a comment at `sync.ts:480` referencing the boundary guard:

```ts
// deviceId is UUID-validated at auth boundary (src/lib/server/auth.ts).
// Do NOT pass user-controlled identifiers to .or() filters without validation.
.or(`device_id.eq.${deviceId},device_id.is.null`)
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] New unit test in `tests/lib/auth.test.ts`: mock supabase to return a `device.id` that is NOT a valid UUID — assert `authenticateDevice` returns `{ error: "invalid_token" }`.

## Open questions

- Performance: regex per request is microseconds. Negligible.
- Should the UUID format be enforced at the DB layer too? The schema declares `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` so it already is, at insert time. The application-layer guard is belt-and-braces against future schema relaxations.

## Dependencies

- Bundles with S2 (siteUrl hardcode) in PR 9. Both are defense-in-depth changes touching auth boundaries.

---

# Issue S2 — Welcome email `siteUrl` from `url.origin` enables Host-header injection on misconfigured self-host proxy

**Status**: open
**Score**: 60
**Severity**: Warning (security — self-host)
**Suggested PR**: 9

## Location

- [`src/lib/server/email.ts:18,27`](../../src/lib/server/email.ts#L18) — `siteUrl` parameter.
- [`src/routes/auth/callback/+server.ts:20-22`](../../src/routes/auth/callback/+server.ts#L20-L22) — call site sets `siteUrl = url.origin`.

## Why it matters

`url.origin` in SvelteKit is derived from the incoming request, including the Host header. The interpolation in `email.ts:27`:

```ts
const html = welcomeHtml.replace(/\{\{APP_URL\}\}/g, `${siteUrl}/app`);
```

…inserts the value verbatim into HTML (most likely an `<a href>` in the welcome template). On Vercel-hosted production this is locked: the platform fixes the Host header to the canonical project domain. But on a self-hosted Node deployment behind a misconfigured reverse proxy that forwards arbitrary Host headers, an attacker can set `Host: phish.example.com`. The welcome email then contains `https://phish.example.com/app` as the call-to-action link.

Attack chain requires:

1. Attacker triggers signup with a victim's email (signup is unauthenticated).
2. Attacker controls or forges the Host header on the auth callback request — easy on an open proxy, harder on a proxy that pins `X-Forwarded-Host`.
3. The victim clicks the welcome email's link, lands on attacker's domain styled to look like Librito.

Bounded but real. OSS self-hosters frequently misconfigure proxies during initial deployment, and the welcome email is the user's first impression — phishing here is high-value.

The fix is trivial: don't trust the Host header for outbound URLs.

## Recommendation

Hardcode the canonical site URL, OR pull from a server-side env var like `PUBLIC_SITE_URL` (which CLAUDE.md self-hosters already configure).

Tradeoff: hardcoding requires a re-deploy to change. Env var costs one line in `.env.example`.

## Implementation

1. Add `PUBLIC_SITE_URL` to `.env.example` and `CLAUDE.md` "Environment Variables".
2. `src/routes/auth/callback/+server.ts:20`:

```ts
import { PUBLIC_SITE_URL } from "$env/static/public";

// ...
sendWelcomeEmail(user.email, PUBLIC_SITE_URL).catch(() => {});
```

3. Optionally, `src/lib/server/email.ts:27` can additionally validate `siteUrl` matches an allowlist or an HTTPS scheme as a belt-and-braces guard:

```ts
function safeSiteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new Error("scheme");
    return parsed.origin; // strips any path/query/fragment injection
  } catch {
    return "https://librito.io"; // fallback to canonical
  }
}

const html = welcomeHtml.replace(
  /\{\{APP_URL\}\}/g,
  `${safeSiteUrl(siteUrl)}/app`,
);
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — existing email tests pass.
- [ ] New unit test: pass a malicious `siteUrl` (e.g. `https://evil.com"><script>`) into `sendWelcomeEmail` — verify the rendered HTML contains the canonical fallback, not the injected value.
- [ ] Manual: tail the dev Resend test inbox during a signup — link should point to canonical domain regardless of local `Host` header.

## Open questions

- Should `PUBLIC_SITE_URL` be documented as required (current behavior breaks if absent) or optional with a default? Default to the current hardcoded canonical (`https://librito.io`) for OSS friendliness; require for self-host clarity.

## Dependencies

- Bundles with S1 (UUID guard) in PR 9.

---

# Issue S3 — 6-digit pairing code brute-force surface

**Status**: skip + document
**Score**: 35

## Location

- [`src/lib/server/tokens.ts:3-5`](../../src/lib/server/tokens.ts#L3-L5)

## Decision

6-digit decimal codes give 1,000,000 possibilities. Rate-limited at 5 attempts per 5 minutes per `code:IP` (`ratelimit.ts:28-32`), 5-minute TTL on the code itself.

Practical brute force per IP per code TTL: 5 attempts ÷ 1M space = 0.0005% success per session. Mounting a sustained attack across hundreds of codes requires hundreds of pairing sessions — the attacker would need to know when a target user is mid-pairing.

The 6-digit format is a UX requirement (user types it on a small e-ink device with a virtual keyboard). Spec-level decision documented in the original pairing spec, not a defect.

## Recommendation

Add a comment in `tokens.ts` documenting the decision so OSS reviewers don't re-flag it.

## Implementation

```ts
/**
 * 6-digit decimal pairing code. UX requirement: user types it on the
 * device's virtual keyboard during pairing.
 *
 * Brute-force surface bounded by ratelimit.ts:pairClaimLimiter
 * (5 attempts / 5 min / code:IP) and the 5-minute code TTL. At those
 * rates, ~0.0005% success per session per IP — acceptable for a
 * one-time-use code that is invalidated after first claim.
 *
 * Larger code space (hex, base32) was considered and rejected on UX
 * grounds — the device keypad is the bottleneck, not entropy.
 */
export function generatePairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
```

---

# Issue S4 — `checkPairingStatus` returns `userEmail` to anyone with a valid `pairingId`

**Status**: skip
**Score**: 30

## Location

- [`src/lib/server/pairing.ts:69-94`](../../src/lib/server/pairing.ts#L69-L94)

## Decision

`pairingId` is a UUIDv4 (122 bits of entropy). Unguessable. The endpoint is rate-limited at 1 req per 3 seconds. Email disclosure requires the pairingId to leak — at that point an attacker has bigger problems than email exposure (they could complete the pairing themselves).

The email display is intentional UX: the device shows the claiming account so the user can confirm they're pairing the right account. Removing it would require a UI rewrite for no security benefit.

Skip. No comment needed — the threat model is documented in CLAUDE.md's "Two auth models" section already.

---

# Issue L1 — Pairing TTL literal `300 / 5*60*1000` repeated 3 places

**Status**: open
**Score**: 70
**Severity**: Polish
**Suggested PR**: 7

## Location

- [`src/lib/server/pairing.ts:33`](../../src/lib/server/pairing.ts#L33) — `PAIR_REDIS_TTL_SEC = 300`.
- [`src/lib/server/pairing.ts:41`](../../src/lib/server/pairing.ts#L41) — `Date.now() + 5 * 60 * 1000`.
- [`src/lib/server/pairing.ts:61`](../../src/lib/server/pairing.ts#L61) — `expiresIn: 300`.

## Why it matters

Three places, one number, two unit systems. A future change to the TTL (e.g. shorten to 2 minutes for tighter security) would require touching all three and risks unit-conversion errors.

OSS contributors editing this file see "5 min" represented in three different forms — invitation to bugs.

## Recommendation

Reuse `PAIR_REDIS_TTL_SEC` everywhere.

## Implementation

`src/lib/server/pairing.ts`:

```ts
const PAIR_REDIS_TTL_SEC = 300;

export async function requestPairingCode(...) {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIR_REDIS_TTL_SEC * 1000);  // ← was 5 * 60 * 1000
  // ...
  return { code, pairingId: data.id, expiresIn: PAIR_REDIS_TTL_SEC };  // ← was 300
}
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — TTL behaviour unchanged.

## Dependencies

- Bundles into PR 7.

---

# Issue L2 — `_retried = false` recursion-state parameter exposed in public signature

**Status**: open
**Score**: 60
**Severity**: Polish
**Suggested PR**: 7

## Location

- [`src/lib/server/pairing.ts:38`](../../src/lib/server/pairing.ts#L38)

## Why it matters

```ts
export async function requestPairingCode(
  supabase: SupabaseClient,
  hardwareId: string,
  _retried = false,
): Promise<PairingResult> { ... }
```

The `_retried` parameter is implementation detail (one-shot collision retry) leaking into the exported signature. Callers see it in autocomplete; OSS contributors might pass `true` thinking it's a "skip retry" flag.

## Recommendation

Inner helper or small loop. Either removes the leading-underscore export hack.

## Implementation

`src/lib/server/pairing.ts`:

```ts
export async function requestPairingCode(
  supabase: SupabaseClient,
  hardwareId: string,
): Promise<PairingResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIR_REDIS_TTL_SEC * 1000);

    const { data, error } = await supabase
      .from("pairing_codes")
      .insert({
        code,
        hardware_id: hardwareId,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single();

    if (!error)
      return { code, pairingId: data.id, expiresIn: PAIR_REDIS_TTL_SEC };
    if (error.code !== "23505")
      throw new Error(`Failed to create pairing code: ${error.message}`);
    // 23505 = unique-violation; retry with a fresh code.
  }
  throw new Error(
    "Failed to create pairing code: unique-collision retry exhausted",
  );
}
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — existing collision-retry test still passes.

## Dependencies

- Bundles into PR 7.

---

# Issue L3 — `validateSyncPayload` repeats range-validation logic for `highlights` and `deletedHighlights`

**Status**: open
**Score**: 65
**Severity**: Polish (readability)
**Suggested PR**: 7

## Location

- [`src/lib/server/sync.ts:174-201`](../../src/lib/server/sync.ts#L174-L201) — highlights chapter/startWord/endWord checks.
- [`src/lib/server/sync.ts:270-300`](../../src/lib/server/sync.ts#L270-L300) — deletedHighlights chapter/startWord/endWord checks (same logic, different error messages).

## Why it matters

`validateSyncPayload` is a single ~200-line function. The two arms validate the same `(chapter, startWord, endWord)` tuple with the same bounds (`0…32767` for chapter, `0…2_147_483_647` for word indices, `endWord >= startWord`). Two near-identical 30-line blocks with only the error-message string differing.

OSS contributors see a 200-line validator and assume it's complex. Extracting `validateRange(obj, label): string | null` halves the function and makes the structure obvious. Future bounds changes (e.g. relaxing the `endWord >= startWord` constraint, which already happened for L2 in the supabase audit) become a single-site edit instead of two.

## Recommendation

Extract `validateRange` helper. Keep the rest of the validator intact.

## Implementation

`src/lib/server/sync.ts`:

```ts
function validateRange(
  obj: Record<string, unknown>,
  label: string, // "Highlight" or "Deleted highlight"
): string | null {
  if (
    typeof obj.chapter !== "number" ||
    obj.chapter < 0 ||
    !Number.isInteger(obj.chapter) ||
    obj.chapter > 32767
  ) {
    return `${label} chapter must be a non-negative integer up to 32767`;
  }
  if (
    typeof obj.startWord !== "number" ||
    obj.startWord < 0 ||
    !Number.isInteger(obj.startWord) ||
    obj.startWord > 2_147_483_647
  ) {
    return `${label} startWord must be a non-negative integer`;
  }
  if (
    typeof obj.endWord !== "number" ||
    !Number.isInteger(obj.endWord) ||
    obj.endWord < obj.startWord ||
    obj.endWord > 2_147_483_647
  ) {
    return `${label} endWord must not be less than startWord`;
  }
  return null;
}

// Replace highlights arm (lines 174-201) with:
const rangeError = validateRange(hl, "Highlight");
if (rangeError) return { error: rangeError };

// Same for deletedHighlights arm (lines 270-300):
const rangeError = validateRange(dl, "Deleted highlight");
if (rangeError) return { error: rangeError };
```

The L4 fix (drop `as number` casts) folds in cleanly here — `validateRange` works on `obj` after the outer typeof checks, no casts needed.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — every existing range-validation test continues to pass with same error strings.

## Dependencies

- Bundles into PR 7. Combines naturally with L4 (cast removal) since both touch the same range checks.

---

# Issue L4 — Unnecessary `as number` casts after `typeof === "number"` narrowing

**Status**: open
**Score**: 75
**Severity**: Polish (type safety hygiene)
**Suggested PR**: 7

## Location

- [`src/lib/server/sync.ts:197`](../../src/lib/server/sync.ts#L197) — `hl.endWord < (hl.startWord as number)`.
- [`src/lib/server/sync.ts:236`](../../src/lib/server/sync.ts#L236) — `(n as number) < 0` in `paragraphBreaks` validation.
- [`src/lib/server/sync.ts:294`](../../src/lib/server/sync.ts#L294) — `dl.endWord < (dl.startWord as number)`.

## Why it matters

The casts exist because TypeScript's narrowing of `Record<string, unknown>` properties through `typeof` checks is incomplete in older versions, but the compiler used here narrows correctly. Each cast is redundant.

OSS contributors copy patterns. Redundant casts spread.

## Recommendation

Drop the casts. After L3's `validateRange` extraction, the casts disappear naturally — the helper accepts a `Record<string, unknown>` and re-narrows internally without casts.

If L3 is deferred, drop the casts in place.

## Implementation

If L3 lands first, this is implicit. Standalone:

```ts
// Before:
hl.endWord < (hl.startWord as number);

// After:
hl.endWord < hl.startWord; // both narrowed to number by surrounding typeof checks
```

## Acceptance

- [ ] `npm run check` clean — no `noImplicitAny` regressions.
- [ ] `npx vitest run` clean.

## Dependencies

- Bundles into PR 7. Folds into L3.

---

# Issue L5 — Validation convention split: `string | null` (`transfer.ts`) vs discriminated union (`sync.ts`)

**Status**: open
**Score**: 60
**Severity**: Polish (codebase consistency)
**Suggested PR**: 8

## Location

- [`src/lib/server/transfer.ts:91-105`](../../src/lib/server/transfer.ts#L91-L105) — `validateTransferFilename`, `validateTransferSize` return `string | null` (null = ok, string = error).
- [`src/lib/server/sync.ts:102-104`](../../src/lib/server/sync.ts#L102-L104) — `validateSyncPayload` returns `{ payload } | { error }` discriminated union.

## Why it matters

Two conventions for "did this validate" in the same module set. OSS contributors writing the next validator will pick one — and either pick will be inconsistent with one of the two existing patterns. Codebase consistency matters more than which convention is "better".

The discriminated-union form scales better when the success case carries a payload (which `validateSyncPayload` does — it returns the validated `payload` for downstream use). The `string | null` form is fine for boolean validators but doesn't carry a value.

## Recommendation

Converge on the discriminated-union form. Both `validateTransferFilename` and `validateTransferSize` become:

```ts
type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateTransferFilename(
  filename: string,
): ValidationResult<string> {
  if (!filename.toLowerCase().endsWith(".epub"))
    return { ok: false, error: "Only EPUB files are accepted" };
  if (filename.length > MAX_FILENAME_LENGTH)
    return { ok: false, error: "Filename exceeds 255 character limit" };
  return { ok: true, value: filename };
}
```

OR — if the payload-carrying value is overkill for these simple validators — keep `string | null` and document the convention as the codebase standard, then migrate `validateSyncPayload` to match. Less work but the validator does need to return `payload` somehow; that path requires a separate "extract payload" call.

Lean toward the discriminated-union form for forward-compat; it's the only shape that scales.

## Implementation

PR 8 bundles this with L6. Touches `transfer.ts` (rewrite two validators) and the call sites in `src/routes/api/transfer/initiate/+server.ts` (and any other consumer — grep for usages).

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — existing tests for both validators pass after call-site updates.
- [ ] Add a lint rule or CLAUDE.md note documenting the chosen convention so future validators converge.

## Open questions

- Worth a CLAUDE.md "Code Patterns" addition explicitly calling out the convention.

## Dependencies

- Independent of B/P/C work. PR 8 bundles with L6.

---

# Issue L6 — `transfer.ts:71` casts RPC return type via `as number | undefined`

**Status**: open (conditional)
**Score**: 50
**Severity**: Polish (type safety)
**Suggested PR**: 8

## Location

- [`src/lib/server/transfer.ts:71`](../../src/lib/server/transfer.ts#L71) — `(row.attempt_count as number | undefined) ?? 0`.

## Why it matters

The cast exists because the RPC return type is untyped at the call site — the project hasn't run `supabase gen types typescript` to produce the `Database` type with full RPC signatures.

If types are generated, the cast disappears via:

```ts
import type { Database } from "$lib/types/database";

type IncrementAttemptReturn =
  Database["public"]["Functions"]["increment_transfer_attempt"]["Returns"];
```

If types aren't generated, the cast is the pragmatic workaround.

## Recommendation

Wire `supabase gen types typescript` into the project (CI step or manual `npm run generate-types` script). One-time setup; pays for itself across every RPC, RLS-typed query, and table reference.

If type generation is out of scope for this audit cycle, leave the cast. Don't refactor without addressing the root cause.

## Implementation

1. Add `npm run generate-types` script to `package.json`:

```json
"scripts": {
  "generate-types": "supabase gen types typescript --local > src/lib/types/database.ts"
}
```

2. Update `CLAUDE.md` "Build Commands" with the new script.

3. Run the script, commit the generated file.

4. Update `transfer.ts:71`:

```ts
type IncrementAttemptReturn =
  Database["public"]["Functions"]["increment_transfer_attempt"]["Returns"][number];

const row = Array.isArray(rpcRows)
  ? rpcRows[0]
  : (rpcRows as IncrementAttemptReturn | null);
const newAttemptCount = row?.attempt_count ?? 0;
const newStatus = row?.status;
```

5. Audit other casts in `src/lib/server/` and `src/routes/` that would resolve once types are generated — there are several.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Manual: `npm run generate-types` runs cleanly against local Supabase.
- [ ] Generated file committed; CI doesn't drift.

## Open questions

- Generated types file size — typically 100-500 lines. Manageable.
- CI: should `generate-types` run on every CI build to detect schema drift? Yes — fail the build if generated diff is non-empty after `npm run generate-types && git diff --exit-code`.

## Dependencies

- L5 + L6 bundle in PR 8. L6 is the bigger lift; consider splitting into its own PR if the type-generation infra is non-trivial.

---

# Issue L7 — `email.ts` per-signup `console.log` when Resend unconfigured

**Status**: open
**Score**: 65
**Severity**: Polish (log hygiene — OSS UX)
**Suggested PR**: 7

## Location

- [`src/lib/server/email.ts:23`](../../src/lib/server/email.ts#L23)

## Why it matters

```ts
if (!client) {
  console.log("RESEND_API_KEY not set — skipping welcome email");
  return;
}
```

Open-source self-hosters often skip Resend (non-critical for first-run). Every signup logs this line. At scale, log noise; for first-time deployers, it implies "something is wrong" when nothing is.

## Recommendation

One-shot warning at module load when the key is absent, OR drop the log entirely. The behaviour (no-op send) is correct in both cases.

## Implementation

`src/lib/server/email.ts`:

```ts
import { Resend } from "resend";
import { RESEND_API_KEY } from "$env/static/private";
import welcomeHtml from "../../../supabase/templates/welcome.html?raw";

if (!RESEND_API_KEY) {
  console.warn(
    "email.resend_unconfigured",
    "RESEND_API_KEY not set — welcome emails will be silently skipped. " +
      "Set RESEND_API_KEY in env to enable.",
  );
}

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(RESEND_API_KEY);
  return resend;
}

export const _getResendClient = getClient;

export async function sendWelcomeEmail(
  email: string,
  siteUrl: string,
): Promise<void> {
  const client = getClient();
  if (!client) return;
  // ...
}
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — existing tests that verify the no-op-without-key path still pass.
- [ ] Manual: cold start without `RESEND_API_KEY` — single warn line at boot, no per-request logs.
- [ ] Manual: cold start with `RESEND_API_KEY` set — no warn line, emails send.

## Dependencies

- Bundles into PR 7.

---

# Issue L8 — `checkKidInJwks` uses identical `console.warn` event name for two distinct conditions

**Status**: open
**Score**: 55
**Severity**: Polish (log hygiene)
**Suggested PR**: 7

## Location

- [`src/lib/server/realtime.ts:51`](../../src/lib/server/realtime.ts#L51) — `realtime.jwks_check_failed` for fetch failure.
- [`src/lib/server/realtime.ts:68`](../../src/lib/server/realtime.ts#L68) — `realtime.jwks_check_failed` for thrown error.
- [`src/lib/server/realtime.ts:62`](../../src/lib/server/realtime.ts#L62) — `realtime.kid_not_in_jwks` for missing-kid case (correctly distinct).

## Why it matters

Two distinct failure modes (HTTP failure vs thrown exception) emit identical event names. Anyone wiring Grafana / Datadog dashboards on the realtime path sees one bucket where two should exist. Operators can't tell from the event name alone whether the issue is upstream (Supabase down) or local (network / config).

## Recommendation

Distinct event names per cause.

## Implementation

`src/lib/server/realtime.ts`:

```ts
async function checkKidInJwks(kid: string, supabaseUrl: string): Promise<void> {
  if (jwksKidConfirmed === kid) return;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) {
      console.warn("realtime.jwks_fetch_non_ok", { status: res.status, kid });
      return;
    }
    const body = (await res.json()) as { keys?: Array<{ kid: string }> };
    const keys = body.keys ?? [];
    if (keys.some((k) => k.kid === kid)) {
      jwksKidConfirmed = kid;
    } else {
      console.warn("realtime.kid_not_in_jwks", {
        kid,
        knownKids: keys.map((k) => k.kid),
      });
    }
  } catch (err) {
    console.warn("realtime.jwks_fetch_threw", { error: String(err), kid });
  }
}
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean — no test depends on the specific event name.

## Dependencies

- Bundles into PR 7.

---

# Issue L9 — `auth.ts:40` `sk_device_` prefix fast-fail has no comment

**Status**: open
**Score**: 40
**Severity**: Polish
**Suggested PR**: 7

## Location

- [`src/lib/server/auth.ts:40-42`](../../src/lib/server/auth.ts#L40-L42)

## Why it matters

```ts
const token = authHeader.slice(7);
if (!token.startsWith("sk_device_")) {
  return { error: "invalid_token" };
}
```

The prefix check rejects malformed tokens before the SHA-256 hash + DB lookup, saving one round-trip per garbage-token request (e.g. credential-stuffing scans). Intent isn't obvious — a contributor might think it's redundant with the DB lookup and remove it.

## Recommendation

One-line comment.

## Implementation

`src/lib/server/auth.ts:40`:

```ts
const token = authHeader.slice(7);
// Fast-fail malformed tokens before the SHA-256 hash + DB hit.
if (!token.startsWith("sk_device_")) {
  return { error: "invalid_token" };
}
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean

## Dependencies

- Bundles into PR 7.

---

# Issues L10–L16 — Skipped polish items

**Status**: skip
**Score**: 15-30 each

Recorded for completeness so future reviews don't re-flag.

| ID  | Location                                                          | Issue                                                      | Reason for skip                                                                                               |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| L10 | [`auth.ts:39`](../../src/lib/server/auth.ts#L39)                  | `slice(7)` magic offset for `"Bearer "`                    | Idiomatic Bearer parsing. Constant extraction adds friction not clarity.                                      |
| L11 | [`email.ts:20-37`](../../src/lib/server/email.ts#L20-L37)         | `try/catch` wraps `getClient()` and template `replace`     | Catch-all on email fire-and-forget is acceptable. Bikeshed.                                                   |
| L12 | [`pairing.ts:86-92`](../../src/lib/server/pairing.ts#L86-L92)     | `let userEmail = ""` conditional assign                    | Reviewer agent withdrew this. Current form readable.                                                          |
| L13 | [`pairing.ts:132-175`](../../src/lib/server/pairing.ts#L132-L175) | `if/else` for `existing` device → `upsertDevice` helper    | Inline reads cleaner; helper hides insert/update result handling.                                             |
| L14 | [`realtime.ts:104`](../../src/lib/server/realtime.ts#L104)        | Destructured `key_ops` unused                              | Real reason — strip from rest spread for `importJWK`. Already commented.                                      |
| L15 | [`sync.ts:508-535`](../../src/lib/server/sync.ts#L508-L535)       | Three near-identical `(result.data ?? []).map(...)` blocks | Shapes differ enough that a generic helper reduces clarity.                                                   |
| L16 | [`ratelimit.ts:14-87`](../../src/lib/server/ratelimit.ts#L14)     | 8 `Ratelimit` constructors                                 | Each constant has a comment justifying its limits; collapsing would hide the per-endpoint rate-limit posture. |

---

# Verified non-issues

The following surfaced during review and were investigated but ruled out. Recorded here so a future review doesn't re-flag them.

- **N1**: `email.ts` lazy `Resend` singleton pattern — correct, matches recommended pattern.
- **N2**: `ratelimit.ts` module-scope `redis` instantiation at import — correct, env-based config matches CLAUDE.md note for `$env/static/private`.
- **N3**: `realtime.ts` `mintRealtimeToken` accepts injected key material — correct test-friendly design (per inline comment).
- **N4**: `realtime.ts` `jwksKidConfirmed` module-scope cache for success-only — correct, recovers automatically after rotation.
- **N5**: `tokens.ts` `generateDeviceToken` uses 32 bytes via `randomBytes` → base64url → 43 chars — well above brute-force threshold.
- **N6**: `auth.ts` SHA-256 of high-entropy device token — KDF correctly omitted because input is already crypto-random (per audit issue D1 in supabase audit).
- **N7**: `errors.ts` `jsonError` / `jsonSuccess` shape — matches CLAUDE.md "Code Patterns" exactly.
- **N8**: `transfer.ts` `recordConfirmFailure` discriminated union — well-typed, no drift.
- **N9**: `transfer.ts` `sanitizeFilename` uses `basename` — correct path-traversal guard.
- **N10**: `transfer.ts` `MAX_FILE_SIZE` / `MAX_FILENAME_LENGTH` / `MAX_PENDING_TRANSFERS` exported as constants — correct, single source of truth.
- **N11**: `pairing.ts` `Redis` interface defined inline — intentional decoupling from `@upstash/redis` direct dependency, supports tests with in-memory mock.
- **N12**: `auth.ts` `AUTH_ERROR_MESSAGES` Record-keyed by `AuthErrorCode` union — correct, exhaustive enforcement at the type layer.
- **N13**: `realtime.ts` `REALTIME_TOKEN_TTL_SECONDS = 86400` — 24h matches the spec §3 + §13 risk #4 referenced in inline comments.
- **N14**: `pairing.ts:55-58` 23505 collision retry-once — correct handling for the 1M-space code uniqueness.
- **N15**: `sync.ts` `Promise.allSettled` for signed URLs (vs `Promise.all`) — intentional fallback path; one URL failure shouldn't drop the entire response.
- **N16**: `sync.ts` `validateSyncPayload` body-must-be-object check — correct trust-boundary enforcement.
- **N17**: `sync.ts` `seenHashes` duplicate-bookHash check — correct early-rejection.

---

# Notes on the review process

- **5 parallel review agents** plus a main-session verification pass — see invocation in conversation transcript at start of session for the full prompts. Three of the five agents converged on the same `sync.ts:596` double-cast (C2 / B3-component / E17), which is a strong signal in itself.
- **Multi-device correctness** (B1) was the highest-value finding the bug-sweep agent surfaced that the security and perf passes both missed. The OSS angle (multi-device-per-user is a power-user feature self-hosters will exercise first) tipped it from "interesting edge case" to "ship before next release".
- **Validation duplication** (L3 + L4) was flagged by both the simplification and types/perf passes. Convergent flags increase confidence — a shared signal across independent reviewers means the issue is real.
- **Existing-code calibration**: several theoretical issues (S3 brute-force, S4 email exposure, C3/C4 env imports) scored below the surfacing threshold because the code has shipped and run without exhibiting the predicted failure. Documented as Skip rather than silently dropped — keeps the next reviewer from re-discovering the same dead end.
