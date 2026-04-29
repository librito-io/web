# Supabase Audit — RLS Policies & Migration Ordering (2026-04-29)

Source-of-truth for fix work that came out of `/repo-review supabase "RLS policies and migration ordering"`. Each issue is a self-contained section a future session can pick up cold.

## Context

- **Trigger**: `/repo-review supabase "RLS policies and migration ordering"` run 2026-04-29.
- **Scope reviewed**: 26 migrations under `supabase/migrations/` + `supabase/config.toml` + `supabase/seed.sql` (28 files). Untracked `supabase/snippets/` and `supabase/signing_keys.json` excluded.
- **Reviewers**: 4 parallel agents (CLAUDE.md compliance, security, perf/types, simplification) + main-session bugs/logic sweep.
- **Calibration**: existing-code (stricter than branch-review). Code that has shipped and run earns trust — theoretical issues penalised.
- **Filtering**: confidence ≥ 80 surfaced as Critical/Warning. Lower scores included for completeness with explicit Skip/Verify recommendations.

## Workflow

1. **One session per fix group** (small focused PRs squash-merge cleanly into archeology).
2. **Each session opens with** "read `docs/supabase-audit-2026-04-29.md`, work on issue X".
3. **Session reads the issue section + the referenced migrations**, implements, tests, opens PR.
4. **Before session closes**: update the Status table here with PR link + status. Add follow-ups discovered during implementation as new sections.

## Closure (2026-04-29)

Audit complete. 10 PRs landed (#27, #28, #29, #30, #31, #32, #33, #34, #35, #36). 17 of 23 issues addressed via PR; the remaining 6 (P6, L3, L4, L5) are documented decisions to keep current behaviour or defer to future migrations. The status overview below is now a historical record — every "open" status row was either merged or explicitly closed without a PR. Per-issue sections retain full implementation detail and verification findings for git blame resolution against the shipped migrations.

## Status overview

| #   | Issue                                                         | Severity       | Score         | PR                                               | Status                 | Session date |
| --- | ------------------------------------------------------------- | -------------- | ------------- | ------------------------------------------------ | ---------------------- | ------------ |
| C1  | `signing_keys_path` committed                                 | Critical       | 95            | [#27](https://github.com/librito-io/web/pull/27) | merged                 | 2026-04-29   |
| S1  | `book_transfers` INSERT RLS bypass                            | Warning (sec)  | 85            | [#28](https://github.com/librito-io/web/pull/28) | merged                 | 2026-04-29   |
| S2  | Storage upload missing `transfer_id` check                    | Warning (sec)  | 85            | [#28](https://github.com/librito-io/web/pull/28) | merged                 | 2026-04-29   |
| S3  | pg_cron scrub vs Vercel sweep racing `storage_path`           | Warning (sec)  | 80            | [#29](https://github.com/librito-io/web/pull/29) | merged                 | 2026-04-29   |
| S4  | `handle_new_user` `search_path` drift                         | Warning (sec)  | 80            | [#30](https://github.com/librito-io/web/pull/30) | merged                 | 2026-04-29   |
| S5  | Notes RLS DELETE bypasses tombstones                          | Warning (sec)  | 75            | [#28](https://github.com/librito-io/web/pull/28) | merged                 | 2026-04-29   |
| P1  | `get_library_with_highlights` bare `auth.uid()`               | Warning (perf) | 88            | [#31](https://github.com/librito-io/web/pull/31) | merged                 | 2026-04-29   |
| P2  | `get_library_with_highlights` per-book correlated subquery    | Warning (perf) | 75            | [#31](https://github.com/librito-io/web/pull/31) | merged                 | 2026-04-29   |
| P3  | `book_transfers` cron lacks status-first index                | Warning (perf) | 78            | [#32](https://github.com/librito-io/web/pull/32) | merged                 | 2026-04-29   |
| P4  | `scrub-retired-transfers` no `IS NULL` index                  | Warning (perf) | 76            | [#32](https://github.com/librito-io/web/pull/32) | merged (folds into P3) | 2026-04-29   |
| P5  | `book_transfers (user_id, status)` for sync hot path          | Warning (perf) | 70            | [#32](https://github.com/librito-io/web/pull/32) | merged                 | 2026-04-29   |
| P6  | `book_transfers` REPLICA IDENTITY FULL Realtime amplification | Warning (perf) | 70            | —                                                | keep + monitor         | —            |
| P7  | Duplicate `highlights` indexes (sync vs feed)                 | Polish         | 50            | [#33](https://github.com/librito-io/web/pull/33) | merged (comment-only)  | 2026-04-29   |
| D1  | `devices.api_token_hash` comment claims argon2id/bcrypt       | Doc            | 70            | [#33](https://github.com/librito-io/web/pull/33) | merged                 | 2026-04-29   |
| D2  | `seed.sql` zero-hash sentinel                                 | Doc            | 65            | [#34](https://github.com/librito-io/web/pull/34) | merged                 | 2026-04-29   |
| D3  | `cover_cache` reads need `authenticated`, no anon             | Doc            | 50            | [#36](https://github.com/librito-io/web/pull/36) | merged (Path A)        | 2026-04-29   |
| D4  | `book_transfers.uploaded_at` semantics                        | Doc            | 55            | [#33](https://github.com/librito-io/web/pull/33) | merged (Option B)      | 2026-04-29   |
| D5  | `book_transfers` no UPDATE/DELETE policies                    | Doc            | informational | [#33](https://github.com/librito-io/web/pull/33) | merged (comment-only)  | 2026-04-29   |
| L1  | `get_highlight_feed` cursor drops NULL title/author           | Polish         | 78            | [#31](https://github.com/librito-io/web/pull/31) | merged                 | 2026-04-29   |
| L2  | `valid_word_range > vs >=` for single-word highlights         | Polish         | 55            | [#35](https://github.com/librito-io/web/pull/35) | merged (Path B)        | 2026-04-29   |
| L3  | `notes` 4 separate per-action policies                        | Polish         | 40            | —                                                | future-only            | —            |
| L4  | Duplicated realtime publication guard                         | Polish         | 35            | —                                                | future-only            | —            |
| L5  | `cover_cache.id` unused                                       | Polish         | 30            | —                                                | skip                   | —            |

## Suggested PR groupings

| PR # | Issues     | Theme                                                      | Migration count |
| ---- | ---------- | ---------------------------------------------------------- | --------------- |
| 1 ✓  | C1         | config.toml unwind                                         | 0 (config-only) |
| 2 ✓  | S1, S2, S5 | Browser-side RLS hardening                                 | 1               |
| 3    | S3         | Storage scrub-vs-sweep ordering                            | 1               |
| 4    | S4         | search_path drift on `handle_new_user`                     | 1               |
| 5    | P1, P2, L1 | `get_library_with_highlights` rewrite + cursor NULL safety | 1               |
| 6    | P3, P4, P5 | Cron + sync indexes                                        | 1               |
| 7    | D1, D5, D4 | Schema comments / column rename                            | 1               |
| 8    | D2         | seed.sql sentinel                                          | 0 (seed only)   |
| 9    | L2         | `valid_word_range` device-bounds verification              | 0 or 1          |
| 10   | D3         | cover_cache anon access decision                           | 0 or 1          |

PRs 2 / 3 / 5 carry the bulk of the security and perf risk; tackle in that order. PRs 6 / 7 / 8 are independent and parallelisable. PRs 9 / 10 require external verification (device firmware bounds; web-app anon read paths) and may close as "no change needed" + comment-only.

---

# Issue C1 — `signing_keys_path` committed uncommented

**Status**: merged ([#27](https://github.com/librito-io/web/pull/27))
**Score**: 95
**Severity**: Critical

Brief: line was inadvertently committed uncommented in #25. Restored to the upstream Supabase CLI default (commented). Full archeology in commit `e491180`. Self-hosters and CI now succeed; per-dev override pattern documented in CLAUDE.md "Local dev setup — Realtime signing key" step 3.

---

# Issue S1 — `book_transfers` INSERT RLS lets browsers bypass quota / rate-limit via PostgREST

**Status**: open
**Score**: 85
**Severity**: Warning (security)
**Suggested PR**: 2

## Location

- [`supabase/migrations/20260412000006_create_rls_policies.sql:96-105`](../../supabase/migrations/20260412000006_create_rls_policies.sql)
- [`supabase/migrations/20260427000004_optimize_rls_auth_uid_subquery.sql:50-59`](../../supabase/migrations/20260427000004_optimize_rls_auth_uid_subquery.sql) (subquery-wrap of the same policy)

## Why it matters

The INSERT policy's `WITH CHECK` validates `user_id` ownership and (if `device_id` set) device ownership — but does not constrain `status`, `filename`, `file_size`, `sha256`. The column `status` defaults to `'pending'` and `valid_transfer_status` only checks the value is in the allowed enum, not who set it.

An authenticated browser can `POST /rest/v1/book_transfers` directly with arbitrary fields and create rows that bypass:

- `MAX_PENDING_TRANSFERS` cap enforced in `/api/transfer/initiate`
- Rate limiter (`@upstash/ratelimit` instances)
- Filename / filesize / mime validation in the API route

The actual file upload to Storage is independently gated by the storage bucket policy (S2) — so no real bytes land. But DB row pollution is real:

- Phantom pending rows count against any future per-user quota
- The `idx_transfers_dedup_pending` partial unique constraint stops same-sha256 duplicate uploads but lets distinct synthetic hashes through
- Cron jobs (`expire-stale-transfers`, `scrub-retired-transfers`) waste cycles on phantom rows

OSS context: adversaries read source. Defense-in-depth matters.

## Recommendation

**Drop the INSERT policy entirely**. Force all inserts through `/api/transfer/initiate` (service_role bypasses RLS).

Alternative if dropping is too aggressive: tighten `WITH CHECK` to constrain initial state.

## Implementation

New migration `<timestamp>_drop_book_transfers_browser_insert.sql`:

```sql
DROP POLICY IF EXISTS "Users can create own transfers"
  ON public.book_transfers;
```

If the alternative tightening is preferred:

```sql
ALTER POLICY "Users can create own transfers" ON public.book_transfers
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND status = 'pending'
    AND attempt_count = 0
    AND scrubbed_at IS NULL
    AND (
      device_id IS NULL OR device_id IN (
        SELECT id FROM public.devices WHERE user_id = (SELECT auth.uid())
      )
    )
  );
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Manual: `curl -X POST` to `https://<local>/rest/v1/book_transfers` with valid auth user JWT and minimal valid body returns 401 / 403 (drop variant) or 403 with constraint violation (tighten variant)
- [ ] `/api/transfer/initiate` still works (uses service_role)
- [ ] `npx supabase db push --dry-run` shows only the new migration

## Open questions

- Are any unit tests in `tests/` exercising this policy? grep `book_transfers` in `tests/`. Drop variant may break tests that assume browser-side INSERT works.

## Dependencies

- Bundled with S2 + S5 in PR 2 since all three are browser-side RLS hardening.

---

# Issue S2 — Storage upload policy doesn't verify path's `transfer_id`

**Status**: open
**Score**: 85
**Severity**: Warning (security)
**Suggested PR**: 2

## Location

- [`supabase/migrations/20260412000007_create_storage.sql:33-41`](../../supabase/migrations/20260412000007_create_storage.sql)
- [`supabase/migrations/20260427000004_optimize_rls_auth_uid_subquery.sql:63-67`](../../supabase/migrations/20260427000004_optimize_rls_auth_uid_subquery.sql)

## Why it matters

Path convention is `{user_id}/{transfer_id}/{filename}`. The current `WITH CHECK` only validates `(storage.foldername(name))[1] = auth.uid()::text`. Authenticated users can upload arbitrary 50 MB EPUB files to any `{their_user_id}/any-uuid/any-file.epub` path with no corresponding `book_transfers` row.

Concrete impact:

- Storage abuse — quota burn capped only by Supabase plan limits
- Permanent orphans — no DB row exists to drive the scrub/sweep pipeline
- Defeats the entire transfer state machine for the abuser

If S1 is fixed by dropping the INSERT policy (recommended), the only legitimate path to a Storage upload is via `/api/transfer/initiate`, which produces a known `transfer_id`. The Storage policy can then enforce that the path's `transfer_id` matches a real pending row.

## Recommendation

Tighten the upload `WITH CHECK` to require the path's second segment match a pending transfer row owned by the user.

## Implementation

New migration `<timestamp>_tighten_book_transfers_storage_policy.sql`:

```sql
ALTER POLICY "Users can upload book transfers" ON storage.objects
  WITH CHECK (
    bucket_id = 'book-transfers'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND (storage.foldername(name))[2]::uuid IN (
      SELECT id FROM public.book_transfers
       WHERE user_id = (SELECT auth.uid())
         AND status = 'pending'
    )
  );
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Manual: upload via the legitimate `/api/transfer/initiate` → signed URL flow still works
- [ ] Manual: direct `PUT https://<storage-url>/object/book-transfers/<uuid>/<uuid>/foo.epub` with a non-existent `transfer_id` returns 403
- [ ] Manual: same upload with `(storage.foldername(name))[2]` pointing at another user's `transfer_id` returns 403

## Open questions

- Cast `[2]::uuid` may error on malformed paths. Postgres returns `invalid_text_representation`; the policy then fails closed (good). Verify behaviour in local Supabase.
- Is there a path where `transfer_id` is set after the row exists but before status is `'pending'`? Confirm by reading `/api/transfer/initiate/+server.ts` flow — initiate inserts with `status='pending'` and returns the id, so this is fine.

## Dependencies

- Bundled with S1 + S5 in PR 2.

---

# Issue S3 — pg_cron `scrub-retired-transfers` and Vercel-cron `transfer-sweep` both null `storage_path` with no ordering guarantee

**Status**: merged ([#29](https://github.com/librito-io/web/pull/29))
**Score**: 80
**Severity**: Warning (security / data integrity)
**Suggested PR**: 3 (shipped)

## Location

- pg_cron scrub: [`supabase/migrations/20260423000001_transfer_post_e2ee.sql:77-92`](../../supabase/migrations/20260423000001_transfer_post_e2ee.sql)
- Vercel sweep: [`src/routes/api/cron/transfer-sweep/+server.ts`](../../src/routes/api/cron/transfer-sweep/+server.ts) Pass A

## Why it matters

The Vercel sweep deletes the Storage object then nulls `storage_path` (Pass A). The independent pg_cron `scrub-retired-transfers` job nulls `storage_path` (along with `filename`, `sha256`) any time `status='downloaded' AND downloaded_at < now() - 24h` OR `status='expired' AND uploaded_at < now() - 49h`.

Race: if pg*cron fires \_before* the Vercel sweep wins, the Storage object becomes a permanent orphan because `storage_path` is gone before the sweep can read it. The sweep code's own comment acknowledges this gap: _"Pass C (future workstream) sweeps orphans by listing the bucket and reconciling."_

At 1k users this leaks measurable storage even at low miss rates.

## Recommendation

Gate the pg_cron scrub so it only nulls `storage_path` AFTER the Vercel sweep has cleared it. Cleanest: remove `storage_path` from pg_cron's `SET` clause entirely — let the Vercel sweep own that field exclusively.

Alternative: gate the pg_cron `WHERE` on `storage_path IS NULL` so it only runs against rows the sweep already touched.

## Implementation

Option A (preferred — sweep owns `storage_path`):

```sql
-- New migration <timestamp>_pg_cron_scrub_no_storage_path.sql
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'scrub-retired-transfers';

SELECT cron.schedule(
  'scrub-retired-transfers',
  '0 * * * *',
  $$
    UPDATE public.book_transfers
    SET filename = NULL,
        sha256 = NULL,
        scrubbed_at = now()
    WHERE scrubbed_at IS NULL
      AND storage_path IS NULL  -- only after Vercel sweep cleared it
      AND (
        (status = 'downloaded' AND downloaded_at < now() - interval '24 hours')
        OR (status = 'expired' AND uploaded_at < now() - interval '49 hours')
      );
  $$
);
```

Option B (gate-only, simpler diff):

```sql
-- Add storage_path IS NULL to existing WHERE; same SET clause.
-- Side-effect: rows where Vercel sweep is pathologically broken stay un-scrubbed.
-- Acceptable: incident, not silent leak.
```

Option A trades simplicity for stronger invariant — Vercel sweep is the only path that touches `storage_path`. Recommended.

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Local: insert a fake `'downloaded'` row with `downloaded_at = now() - 25h` and `storage_path` set. Run pg_cron job manually (`SELECT cron.run(jobid)`). Confirm row is NOT scrubbed (option A: scrubbed_at remains NULL because storage_path is non-null).
- [ ] Local: same row but `storage_path = NULL`. Run cron. Confirm scrubbed.
- [ ] Vercel sweep endpoint still functions (no cross-effect)

## Open questions

- Pass C (future) was supposed to reconcile orphans. Does this fix obviate Pass C? Likely — if pg_cron only runs after Vercel sweep clears the path, orphans only happen if the Storage object delete itself fails. Worth a follow-up.
- What about `'failed'` status? Per `20260425000001`, `expire-stale-transfers` flips `'failed'` → `'expired'` after 48h, so it eventually flows through the same scrub path. No additional handling needed.

## Dependencies

- Independent of other PRs.

---

# Issue S4 — `handle_new_user` SECURITY DEFINER uses `SET search_path = public` (drift from project hardening pattern)

**Status**: merged ([#30](https://github.com/librito-io/web/pull/30))
**Score**: 80
**Severity**: Warning (security / consistency)
**Suggested PR**: 4 (shipped)

## Resolution

New migration `20260429000003_harden_handle_new_user_search_path.sql` re-`CREATE OR REPLACE`s `public.handle_new_user` with `SET search_path = ''`. Body unchanged (`INSERT INTO public.profiles (id) VALUES (NEW.id)` was already fully qualified). Trigger preserved by `CREATE OR REPLACE` semantics; the `REVOKE EXECUTE` from `20260427000003` also persists (CREATE OR REPLACE keeps existing grants).

Audit query against the local DB before writing the migration:

```sql
SELECT proname, prosecdef, proconfig FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace AND prosecdef = true;
-- → only handle_new_user; no other SECURITY DEFINER functions in public.
```

So this PR is the complete coverage — no fold-ins required.

Verification on local Supabase:

- `supabase db push --local` applied cleanly.
- `pg_proc.proconfig` now shows `{"search_path=\"\""}` for `handle_new_user`.
- `\df+ public.handle_new_user` confirms only `postgres` + `service_role` retain EXECUTE (REVOKE persisted).
- Signup against gotrue (`POST /auth/v1/signup`) creates a row in `public.profiles` via the trigger.
- `npm run check` — 0 errors.
- `npx vitest run` — 239 pass, 0 fail.

## Location

- [`supabase/migrations/20260412000001_create_profiles.sql:18-29`](../../supabase/migrations/20260412000001_create_profiles.sql)

## Why it matters

The project shipped [`20260427000001_harden_update_updated_at_search_path.sql`](../../supabase/migrations/20260427000001_harden_update_updated_at_search_path.sql) to pin `update_updated_at`'s `search_path = ''` and fully qualify `pg_catalog.now()` — defeats search_path injection on SECURITY DEFINER functions.

`handle_new_user` is also SECURITY DEFINER and was missed in that pass. Body is currently safe (single fully-qualified `INSERT INTO public.profiles`) but the guard is missing. Next edit could regress without the guard catching it.

Consistency matters in OSS where multiple contributors edit. The project clearly cares about this advisor (ran the cleanup PR) — leaving one function out is drift.

## Recommendation

Re-`CREATE OR REPLACE` the function with `SET search_path = ''` and verify the body is fully qualified.

## Implementation

New migration `<timestamp>_harden_handle_new_user_search_path.sql`:

```sql
-- Harden handle_new_user against search_path injection.
-- Mirror the pattern applied to update_updated_at in 20260427000001.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$;
```

(Trigger does not need recreation — `CREATE OR REPLACE FUNCTION` updates the body in place.)

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Local: sign up a new user via `/auth/signup`, confirm row appears in `profiles` table
- [ ] `npx supabase db push --dry-run` clean

## Open questions

- Are there any _other_ SECURITY DEFINER functions still missing the guard? Audit at `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef = true;`. If others surface, fold into same PR.

## Dependencies

- Independent.

---

# Issue S5 — Notes RLS DELETE policy hard-deletes, bypassing tombstone (`deletedNotes[]` sync contract)

**Status**: open
**Score**: 75
**Severity**: Warning (data consistency)
**Suggested PR**: 2

## Location

- DELETE policy: [`supabase/migrations/20260412000006_create_rls_policies.sql:81-84`](../../supabase/migrations/20260412000006_create_rls_policies.sql)
- Tombstone column added: [`supabase/migrations/20260426000001_notes_tombstones_and_realtime.sql:12-13`](../../supabase/migrations/20260426000001_notes_tombstones_and_realtime.sql)
- Web app's current correct soft-delete pattern: [`src/lib/components/HighlightCard.svelte:69-78`](../../src/lib/components/HighlightCard.svelte)

## Why it matters

`/api/sync` returns `deletedNotes[]` to the device by selecting rows where `deleted_at IS NOT NULL`. The web app currently uses `UPDATE deleted_at = now()` (soft-delete) — correct.

But the RLS DELETE policy permits hard-DELETE via PostgREST `/rest/v1/notes`. A future contributor (or a bug) calling `.delete()` on the Supabase client would hard-delete the row, eliminating the tombstone. The device would never receive a `deletedNotes` entry and would retain the stale note text indefinitely.

OSS contributor risk is high — `.delete()` is the obvious idiom for "delete a row" and the DB silently accepts it. Defence-in-depth: enforce the soft-delete invariant at the RLS layer.

## Recommendation

Drop the DELETE policy. If future flexibility is needed, add a BEFORE DELETE trigger that converts DELETE to soft-delete (sets `deleted_at = now()` and returns NULL).

Cleanest: drop the policy. The web app already uses the UPDATE pattern; CLAUDE.md can document the convention.

## Implementation

New migration `<timestamp>_drop_notes_browser_delete.sql`:

```sql
-- Notes use soft-delete via deleted_at (added in 20260426000001) so the
-- /api/sync deletedNotes[] response can drive device-side cleanup.
-- A hard DELETE bypasses the tombstone and breaks the sync contract.
-- Drop the DELETE policy; the web app must UPDATE deleted_at = now().

DROP POLICY IF EXISTS "Users can delete own notes" ON public.notes;

COMMENT ON TABLE public.notes IS
  'User notes attached to highlights, created/edited via web app. '
  'Soft-delete via deleted_at — the sync /api/sync deletedNotes[] response '
  'requires the tombstone row to remain queryable. DO NOT add an RLS DELETE '
  'policy back; use UPDATE deleted_at = now() in the browser instead.';
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Local: trash a note via the web UI's existing flow — works
- [ ] Local: attempt `supabase.from('notes').delete().eq('id', X)` from a browser session — returns 0 rows affected / no error (PostgREST suppresses RLS-blocked deletes silently). Confirm row still exists.
- [ ] Local: empty-trashed-notes pg_cron job still hard-deletes 30-day-old rows (it runs as `postgres` superuser via `cron.schedule`, RLS doesn't apply)

## Open questions

- Is `empty-trashed-notes` actually a hard DELETE? Yes — see [`20260426000001:53-61`](../../supabase/migrations/20260426000001_notes_tombstones_and_realtime.sql). Runs as superuser, RLS bypassed, hard DELETE permitted. No conflict.
- Any other browser flow that calls `.delete()` on `notes`? grep `from(['"]notes['"]).*delete` in `src/`. Currently no — only the soft-delete pattern in HighlightCard.

## Dependencies

- Bundled with S1 + S2 in PR 2 (browser RLS hardening theme).

---

# Issue P1 — `get_library_with_highlights` calls bare `auth.uid()` twice in correlated subqueries

**Status**: merged ([#31](https://github.com/librito-io/web/pull/31))
**Score**: 88
**Severity**: Warning (perf at 1k)
**Suggested PR**: 5 (shipped)

## Location

- [`supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql:33`](../../supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql) (`WHERE b.user_id = auth.uid()`)
- [`supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql:65`](../../supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql) (`AND h.user_id = auth.uid()`)

## Why it matters

[`20260427000004_optimize_rls_auth_uid_subquery.sql`](../../supabase/migrations/20260427000004_optimize_rls_auth_uid_subquery.sql) wrapped every RLS policy `auth.uid()` call in `(SELECT auth.uid())` to satisfy the Supabase advisor's "Auth RLS Initialization Plan" warning. That migration only touched `ALTER POLICY` statements — it did not touch SQL function bodies.

In a `SECURITY INVOKER` SQL function, each bare `auth.uid()` call inside a correlated subquery is re-evaluated for every row scanned. Same advisor class as the RLS one. Sibling RPC `get_highlight_feed` is plpgsql with `v_uid uuid := auth.uid()` declared once in the DECLARE block — the correct pattern.

At 1k-user scale with 50+ books per library, the per-row re-evaluation matters. Codebase consistency: align with the pattern already used in `get_highlight_feed`.

## Recommendation

Rewrite as plpgsql with `v_uid` declared once. Mirrors `get_highlight_feed` style.

Optionally fold P2 (N+1 lateral join) and L1 (cursor NULL safety in `get_highlight_feed`) into the same PR — all three are RPC quality fixes.

## Implementation

New migration `<timestamp>_optimize_get_library_with_highlights.sql`:

```sql
-- Convert get_library_with_highlights to plpgsql with cached auth.uid().
-- Mirrors get_highlight_feed's pattern. Caches the auth.uid() result
-- once per call rather than re-evaluating per row.

CREATE OR REPLACE FUNCTION public.get_library_with_highlights()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_out  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH books_ordered AS (
    SELECT b.id, b.book_hash, b.title, b.author, b.language, b.isbn,
           b.updated_at,
           COALESCE(
             (SELECT MAX(h.updated_at)
                FROM highlights h
               WHERE h.book_id = b.id
                 AND h.deleted_at IS NULL),
             b.updated_at
           ) AS last_activity
      FROM books b
     WHERE b.user_id = v_uid
  ),
  book_rows AS (
    SELECT bo.*,
           COALESCE(
             (SELECT jsonb_agg(...)
                FROM highlights h
                LEFT JOIN notes n ON n.highlight_id = h.id AND n.deleted_at IS NULL
               WHERE h.book_id = bo.id
                 AND h.user_id = v_uid
                 AND h.deleted_at IS NULL),
             '[]'::jsonb
           ) AS highlights
      FROM books_ordered bo
  )
  SELECT COALESCE(jsonb_agg(...), '[]'::jsonb) INTO v_out
    FROM book_rows br;

  RETURN v_out;
END;
$$;
```

(Drop the old SQL-language function definition first via `DROP FUNCTION IF EXISTS public.get_library_with_highlights();` — language change requires drop.)

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Local: load `/app` library page — content renders identically to before
- [ ] Local: `EXPLAIN ANALYZE SELECT get_library_with_highlights();` against a seeded 50-book user — no per-row InitPlan node on `auth.uid()`
- [ ] `npx supabase db push --dry-run` clean

## Open questions

- Re-creating the function may invalidate any object that depends on it (PostgREST cache, etc.). Run `npx supabase db reset` locally to confirm clean recreation.
- Function signature unchanged — caller code untouched.

## Dependencies

- Possible bundle with P2 + L1 in PR 5.

---

# Issue P2 — `get_library_with_highlights` per-book correlated subquery (N+1)

**Status**: merged ([#31](https://github.com/librito-io/web/pull/31))
**Score**: 75
**Severity**: Warning (perf at 1k)
**Suggested PR**: 5 (shipped)

## Location

- [`supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql:38-70`](../../supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql) — the `book_rows` CTE's inner subquery

## Why it matters

The `book_rows` CTE issues a correlated subquery per book row to aggregate that book's highlights+notes. Postgres can sometimes optimise these via index-nested-loop on `idx_highlights_book`, but cannot batch the aggregation across all books in a single pass.

At 50 books × 1k users loading concurrently → 50k subquery invocations per request wave. The sibling RPC `get_highlight_feed` (introduced in `20260415000002`) avoids this with a flat JOIN — the correct pattern.

## Recommendation

Restructure as a `LEFT JOIN LATERAL` or a flat aggregation grouped by book. Mirrors `get_highlight_feed`'s flat-JOIN style.

Architectural: the codebase already has the pattern; using it twice keeps the two RPCs consistent.

## Implementation

Bundle with P1 in PR 5. Replace the per-book correlated subquery with:

```sql
-- Inside the rewritten function body:
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', h.id,
      'chapter_index', h.chapter_index,
      ...
      'note_text', n.text,
      'note_updated_at', n.updated_at
    )
    ORDER BY h.chapter_index ASC, h.start_word ASC
  ) AS highlights
    FROM highlights h
    LEFT JOIN notes n ON n.highlight_id = h.id AND n.deleted_at IS NULL
   WHERE h.book_id = bo.id
     AND h.user_id = v_uid
     AND h.deleted_at IS NULL
) hl ON true
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Local: `EXPLAIN ANALYZE` on a seeded 50-book user — query plan shows hash join or merge join, not nested loop with per-row subquery
- [ ] Local: visually compare returned JSON shape — identical to before

## Open questions

- LATERAL semantics differ subtly from correlated subquery — confirm aggregation order via the `ORDER BY` clause inside `jsonb_agg`. Verify against existing snapshot.

## Dependencies

- Bundle with P1 + L1 in PR 5.

---

# Issue P3 — `book_transfers` cron WHERE `status IN (...)` has no covering index

**Status**: merged ([#32](https://github.com/librito-io/web/pull/32))
**Score**: 78
**Severity**: Warning (perf at 1k)
**Suggested PR**: 6 (shipped)

## Resolution

New migration `20260429000005_index_book_transfers_hot_paths.sql` adds four partial / composite indexes covering every cron + sync hot-path predicate touching `book_transfers`. EXPLAIN ANALYZE on a 10k-row seeded table confirms each query picks the new index (Bitmap Index Scan, sub-ms):

- `idx_transfers_unscrubbable_uploaded (uploaded_at) WHERE status IN ('pending','failed')` — `expire-stale-transfers`.
- `idx_transfers_downloaded_unscrubbed (downloaded_at) WHERE scrubbed_at IS NULL AND status = 'downloaded'` — `scrub-retired-transfers` downloaded branch.
- `idx_transfers_expired_unscrubbed (uploaded_at) WHERE scrubbed_at IS NULL AND status = 'expired'` — `scrub-retired-transfers` expired branch (added on second pass; see audit-body errata below).
- `idx_transfers_user_status (user_id, status)` — `/api/sync` hot path.

P4 is fully subsumed by `idx_transfers_downloaded_unscrubbed` — the proposed `WHERE scrubbed_at IS NULL` covering index would have indexed the entire un-scrubbed table; the partials here are exactly scoped to each scrub-branch predicate.

**Audit-body errata caught and closed in this PR**: the original Implementation block claimed `idx_transfers_unscrubbable_uploaded`'s `status IN ('pending','failed')` partial covered the scrub job's `status='expired'` branch by subset. False — `'expired'` is not in `('pending','failed')`, so the planner would fall back to a seq scan. A self-review during PR 6 caught the gap; rather than defer to a follow-up, a fourth index (`idx_transfers_expired_unscrubbed`, symmetric to the downloaded-branch partial but keyed on `uploaded_at`) was added in the same migration. Implementation block above corrected.

## Location

- Cron jobs: [`supabase/migrations/20260423000001_transfer_post_e2ee.sql:66-92`](../../supabase/migrations/20260423000001_transfer_post_e2ee.sql)
- Existing index: [`supabase/migrations/20260412000005_create_indexes_and_triggers.sql:14`](../../supabase/migrations/20260412000005_create_indexes_and_triggers.sql) — `idx_transfers_device (device_id, status)` leads with `device_id`, useless for status-first scans
- Update: [`supabase/migrations/20260425000001_extend_expire_failed_transfers.sql`](../../supabase/migrations/20260425000001_extend_expire_failed_transfers.sql) — adds `status IN ('pending','failed')` to expire job

## Why it matters

The hourly cron jobs `expire-stale-transfers` and `scrub-retired-transfers` filter `WHERE status IN (...) AND <timestamp> < now() - interval '...'`. No index leads with `status` or `(status, timestamp)`.

Current planner choice: seq scan or `idx_transfers_user` filter — fine at 100s of rows, becomes hot path noise at 10k+ rows. At 1k users × ~10 transfers each = 10k baseline; growth doubles the baseline easily.

## Recommendation

Add four indexes covering each distinct cron + sync predicate exactly. Folds in P4 (`scrub-retired-transfers WHERE scrubbed_at IS NULL`) and P5 (`(user_id, status)` sync hot path) into the same migration.

**Errata to original audit body**: an earlier draft of this section claimed `idx_transfers_unscrubbable_uploaded`'s `WHERE status IN ('pending', 'failed')` predicate covered the scrub-retired-transfers `'expired'` branch by subset. That claim is false — `'expired'` is not in `('pending', 'failed')`, so the planner would fall back to a seq scan. Self-review caught the gap mid-PR; the fourth index below closes it.

## Implementation

New migration `<timestamp>_index_book_transfers_hot_paths.sql`:

```sql
-- expire-stale-transfers: WHERE status IN ('pending', 'failed')
--   AND uploaded_at < now() - interval '48 hours'
CREATE INDEX IF NOT EXISTS idx_transfers_unscrubbable_uploaded
  ON public.book_transfers (uploaded_at)
  WHERE status IN ('pending', 'failed');

-- scrub-retired-transfers, downloaded branch: WHERE scrubbed_at IS NULL
--   AND status = 'downloaded' AND downloaded_at < now() - interval '24 hours'
CREATE INDEX IF NOT EXISTS idx_transfers_downloaded_unscrubbed
  ON public.book_transfers (downloaded_at)
  WHERE scrubbed_at IS NULL AND status = 'downloaded';

-- scrub-retired-transfers, expired branch: WHERE scrubbed_at IS NULL
--   AND status = 'expired' AND uploaded_at < now() - interval '49 hours'
-- Symmetric to idx_transfers_downloaded_unscrubbed but keyed on
-- uploaded_at, since expired rows have downloaded_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_transfers_expired_unscrubbed
  ON public.book_transfers (uploaded_at)
  WHERE scrubbed_at IS NULL AND status = 'expired';

-- /api/sync hot path: WHERE user_id = X AND status IN ('pending', 'failed')
CREATE INDEX IF NOT EXISTS idx_transfers_user_status
  ON public.book_transfers (user_id, status);
```

Coverage mapping:

| Index                                 | Query covered                                                        |
| ------------------------------------- | -------------------------------------------------------------------- |
| `idx_transfers_unscrubbable_uploaded` | `expire-stale-transfers` (P3)                                        |
| `idx_transfers_downloaded_unscrubbed` | `scrub-retired-transfers` downloaded branch (P3 + P4)                |
| `idx_transfers_expired_unscrubbed`    | `scrub-retired-transfers` expired branch (P3 — added on second pass) |
| `idx_transfers_user_status`           | `/api/sync` per-user per-status filter (P5)                          |

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Local: seed 10k `book_transfers` rows of varying status, run `EXPLAIN ANALYZE` against each cron's UPDATE statement — index used, not seq scan
- [ ] `npx supabase db push --dry-run` clean

## Dependencies

- Bundle with P5 in PR 6.

---

# Issue P4 — `scrub-retired-transfers` `WHERE scrubbed_at IS NULL` has no covering index

**Status**: merged in [#32](https://github.com/librito-io/web/pull/32) via `idx_transfers_downloaded_unscrubbed`
**Score**: 76

The existing `idx_transfers_scrubbed (scrubbed_at) WHERE scrubbed_at IS NOT NULL` (added in `20260423000001`) is the _reverse_ partial index — covers the hard-delete sweep in the Vercel sweep route, not the pg_cron scrub-set.

Subsumed by P3's `idx_transfers_downloaded_unscrubbed` partial index. Close P4 when P3 ships.

---

# Issue P5 — `book_transfers (user_id, status)` for sync hot path

**Status**: merged in [#32](https://github.com/librito-io/web/pull/32) via `idx_transfers_user_status`
**Score**: 70
**Severity**: Warning (perf at 1k)
**Suggested PR**: 6 (shipped)

## Location

- Sync queries: [`src/lib/server/sync.ts`](../../src/lib/server/sync.ts) — filters `WHERE user_id = X AND status = 'pending'` and `WHERE user_id = X AND status = 'failed'`
- Existing indexes: `idx_transfers_user (user_id)` and `idx_transfers_dedup_pending (user_id, sha256) WHERE status='pending'` — neither offers direct status lookup

## Why it matters

Per-user transfer count is small (<100 rows), but the sync endpoint runs per device per ~30 seconds. At 1k devices × 30 s sync interval = 33 q/s. `idx_transfers_user` covers `user_id` only — Postgres scans all that user's rows then filters status in memory.

Cheap composite index removes the in-memory filter. Aligns with the project's recent FK-coverage sweep [`20260427000005_index_composite_fks.sql`](../../supabase/migrations/20260427000005_index_composite_fks.sql).

## Recommendation

Add `idx_transfers_user_status (user_id, status)`.

## Implementation

Bundle with P3 in PR 6:

```sql
CREATE INDEX IF NOT EXISTS idx_transfers_user_status
  ON public.book_transfers (user_id, status);
```

## Acceptance

- [ ] `EXPLAIN ANALYZE` on `SELECT id FROM book_transfers WHERE user_id = X AND status = 'pending'` shows index scan on the new index
- [ ] No regression on existing `idx_transfers_user`-using queries (Postgres planner may prefer the new index where appropriate — fine)

## Dependencies

- Bundle with P3 + P4 in PR 6.

---

# Issue P6 — `book_transfers` REPLICA IDENTITY FULL Realtime amplification

**Status**: keep + monitor
**Score**: 70

## Location

- [`supabase/migrations/20260426000003_enable_realtime_book_transfers.sql:19-31`](../../supabase/migrations/20260426000003_enable_realtime_book_transfers.sql)

## Decision

Keep current setting. The migration's own comment justifies REPLICA IDENTITY FULL as needed because the firmware doesn't have the row pre-image. At pre-launch scale this is fine.

At 1k concurrent uploaders the full-row WAL on every `attempt_count`/`status` change adds up. Supabase free tier has a 2 MB/s Realtime cap; Pro tier higher. The action is to add observability now so we can detect saturation, not to change the setting prematurely.

## Recommendation

- No code change in this PR cycle.
- Add a Grafana / log line tracking Realtime publication throughput (separate session — not a Supabase migration concern).
- Revisit at Supabase Pro upgrade or when concurrent uploaders > 100.

## Cross-link

- See `docs/post-launch-followups.md` for related observability notes (if applicable).

---

# Issue P7 — Duplicate-purpose indexes on `highlights`

**Status**: merged ([#33](https://github.com/librito-io/web/pull/33)) — comment-only via `20260429000006_document_schema_invariants.sql`
**Score**: 50

## Location

- [`supabase/migrations/20260412000005_create_indexes_and_triggers.sql:8`](../../supabase/migrations/20260412000005_create_indexes_and_triggers.sql) — `idx_highlights_sync (user_id, updated_at)` (no partial filter, includes tombstones — sync uses this)
- [`supabase/migrations/20260415000002_create_highlight_feed.sql:15-17`](../../supabase/migrations/20260415000002_create_highlight_feed.sql) — `highlights_user_updated_idx (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL` (partial — feed uses this)

## Decision

Both indexes serve different queries. Sync needs tombstones; feed needs only live rows. Cannot consolidate without breaking one.

The double-write cost on `INSERT/UPDATE` is real but small. At 1k users this is acceptable.

## Recommendation

Add `COMMENT ON INDEX` documenting each index's owner so a future contributor doesn't drop the "redundant" one. Bundle with PR 7 (documentation comments).

## Implementation (in PR 7)

```sql
COMMENT ON INDEX idx_highlights_sync IS
  'Sync hot path: WHERE updated_at > :lastSync includes tombstones (deleted_at IS NOT NULL). DO NOT add a partial filter — sync needs all rows.';

COMMENT ON INDEX highlights_user_updated_idx IS
  'Feed hot path: live rows only, DESC for chronological feed pagination. The partial WHERE deleted_at IS NULL is intentional — feed never shows tombstones.';
```

---

# Issue D1 — `devices.api_token_hash` comment claims "argon2id (preferred) or bcrypt"; actual code uses SHA-256

**Status**: merged ([#33](https://github.com/librito-io/web/pull/33)) — `COMMENT ON COLUMN` shipped in `20260429000006_document_schema_invariants.sql`
**Score**: 70
**Severity**: Doc drift
**Suggested PR**: 7

## Location

- [`supabase/migrations/20260412000002_create_devices_and_pairing.sql:25`](../../supabase/migrations/20260412000002_create_devices_and_pairing.sql)
- Actual code: [`src/lib/server/auth.ts`](../../src/lib/server/auth.ts) — SHA-256 lookup
- CLAUDE.md "Auth (device)" row confirms SHA-256

## Why it matters

OSS reviewers read schema comments first. Wrong algorithm comment looks like a security smell. The choice is actually correct (SHA-256 of high-entropy device token is fine — KDF unnecessary when input is already crypto-random) but the comment doesn't explain that and lies about the algorithm.

## Recommendation

Replace the comment in a `COMMENT ON COLUMN` migration so the rationale travels with the schema.

## Implementation (in PR 7)

```sql
COMMENT ON COLUMN public.devices.api_token_hash IS
  'SHA-256 hex of device API token (sk_device_xxx). The token is generated '
  'with full crypto entropy server-side (src/lib/server/tokens.ts) and shown '
  'to the user once at claim time, then discarded — no KDF needed because '
  'the input is already crypto-random. Matches the lookup performed by '
  'src/lib/server/auth.ts.';
```

## Acceptance

- [ ] `\d+ devices` in psql shows the new comment
- [ ] `npm run check` / vitest still clean

## Dependencies

- Bundle with D5 + D4 in PR 7 (comment-only migrations).

---

# Issue D2 — `seed.sql` uses `api_token_hash = '0000…0000'` placeholder

**Status**: merged ([#34](https://github.com/librito-io/web/pull/34))
**Score**: 65
**Severity**: Doc drift / OSS attractive nuisance
**Suggested PR**: 8 (shipped)

## Location

- [`supabase/seed.sql`](../../supabase/seed.sql) — device-row insert

## Why it matters

`SHA-256(x) = 0…0` has no known preimage, so this is unexploitable today. But the symbol invites future contributor "improvement" into something exploitable. Replace with a non-hex sentinel that fails any hex-format check — and crucially, that signals intent.

## Recommendation

Replace with a clear sentinel string.

## Implementation

Edit `supabase/seed.sql`:

```sql
-- Find the line:
--   api_token_hash = '0000000000000000000000000000000000000000000000000000000000000000',
-- Replace with:
api_token_hash = 'SEED-NOT-A-REAL-HASH-DO-NOT-REPLACE-WITH-REAL-HEX',
```

Note: `devices.api_token_hash` is plain `text` with no format constraint (only `book_transfers.sha256` has the regex check). The sentinel string will never match a real hash because the lookup always sends 64-hex computed via `crypto.createHash('sha256')`.

## Acceptance

- [ ] `npx supabase db reset` succeeds (seed runs cleanly)
- [ ] No real device flow can authenticate as the seed device (the sentinel doesn't match any computed SHA-256 of any token)

## Dependencies

- Independent. Single-file edit, no migration needed.

---

# Issue D3 — `cover_cache` reads require `authenticated`, no anon policy

**Status**: merged Path A ([#36](https://github.com/librito-io/web/pull/36)) — comment-only `COMMENT ON POLICY` shipped in `20260429000008_document_cover_cache_anon_access.sql`.
**Score**: 50

## Location

- [`supabase/migrations/20260412000006_create_rls_policies.sql:108-115`](../../supabase/migrations/20260412000006_create_rls_policies.sql)

## Decision

Currently fine. Browsers reading `cover_cache` rows must be authenticated. Anon flows (e.g., a future public share/embed page) would silently return zero rows from `cover_cache` lookups — easy debug rabbit hole.

## Verification (2026-04-29)

`grep -rn "cover_cache\|coverCache\|cover-cache" src/` returned zero hits. No anon-key path reads `cover_cache` today, and no public share / embed surface is planned in `docs/` (`post-launch-followups.md`, `ws-rt-follow-ups.md`, `superpowers/specs/*`, `superpowers/plans/*` all clean of `share`/`embed` references outside this audit). The cover-cache Storage bucket is `public = true` (`20260412000007:17-25`) — public surfaces should serve covers via `/storage/v1/object/public/cover-cache/<path>` resolved server-side, not via anon-key PostgREST against this table. Path A applies.

## Recommendation

1. **Verify** in `src/` whether any anon-key path reads `cover_cache` (grep `cover_cache`, `coverCache` in `src/lib/**` and `src/routes/**`). — done, none.
2. **If no anon path**: add a `COMMENT ON POLICY` documenting the intent. — done in migration `20260429000008`.
3. **If yes**: broaden the role to `anon, authenticated` or pre-resolve covers server-side and serve via `/api`. — n/a.

## Implementation (Path A — shipped)

```sql
COMMENT ON POLICY "Any authenticated user can read covers" ON public.cover_cache IS
  'Intentional — anon role cannot read cover_cache. Public embed/share '
  'pages should fetch covers via the public cover-cache Storage bucket '
  'directly (/storage/v1/object/public/cover-cache/<path>) using URLs '
  'resolved server-side, OR via a server-side API route using '
  'service_role. The table row itself (ISBN → storage_path) is treated '
  'as authenticated-only metadata even though the underlying file is '
  'world-readable. See audit issue D3 (2026-04-29).';
```

## Status

Shipped as PR 10. Update PR# placeholder once branch is pushed.

---

# Issue D4 — `book_transfers.uploaded_at DEFAULT now()` at row insert, not at upload completion

**Status**: Option B merged ([#33](https://github.com/librito-io/web/pull/33)) — `COMMENT ON COLUMN` shipped in `20260429000006_document_schema_invariants.sql`. **Option A (rename to `initiated_at`) remains open** as a future decision; comment makes the lie navigable but does not fix the misleading column name.
**Score**: 55
**Severity**: Doc / naming clarity
**Suggested PR**: 7

## Location

- [`supabase/migrations/20260412000004_create_utility_tables.sql:19`](../../supabase/migrations/20260412000004_create_utility_tables.sql)

## Why it matters

Column name lies about semantics. Cron uses `uploaded_at` as the 48 h expiry clock counted from row insert (initiate), not from file upload completion. New contributors will mis-read the field; firmware authors might assume "upload finished" semantics.

## Recommendation

Two paths:

**Option A** (clearer, larger diff): rename to `initiated_at` via a new migration. Touches code that reads/writes the column — verify firmware doesn't reference column name (firmware reads JSON from API responses, which are TS-side renames).

**Option B** (smaller diff, lossy): add a `COMMENT ON COLUMN` documenting the actual semantics. Doesn't fix the lie, just documents it.

Lean A for OSS clarity; B if rename surface area is too large.

## Implementation — Option A

```sql
-- New migration <timestamp>_rename_uploaded_at_to_initiated_at.sql
ALTER TABLE public.book_transfers
  RENAME COLUMN uploaded_at TO initiated_at;
```

Then update TS:

```bash
# Find references
grep -rn "uploaded_at\|uploadedAt" src/ tests/

# Rename in TS code
# (sed -i replacements + manual review)
```

Update pg_cron jobs (the column is referenced in the WHERE clauses of `expire-stale-transfers` and `scrub-retired-transfers` — see `20260423000001:73,89`). Re-schedule them with the new column name in the same migration.

## Implementation — Option B

```sql
COMMENT ON COLUMN public.book_transfers.uploaded_at IS
  'Timestamp when /api/transfer/initiate created the row. NOT the upload '
  'completion time — the file upload happens after row insert. Used as '
  'the expiry clock by expire-stale-transfers (48 h from initiate).';
```

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Local: full transfer flow (initiate → upload → confirm → device receive) works
- [ ] Cron expiry behaviour unchanged

## Dependencies

- Option A: substantial. Standalone PR if chosen.
- Option B: bundle with D1 + D5 in PR 7.

---

# Issue D5 — `book_transfers` lacks UPDATE / DELETE RLS policies

**Status**: merged ([#33](https://github.com/librito-io/web/pull/33)) — `COMMENT ON TABLE` shipped in `20260429000006_document_schema_invariants.sql`. Comment tightened from the audit body to drop the stale "(currently) INSERT … but see PR 2 — may be dropped" hedge: PR 2 (#28) is merged and the INSERT policy is gone. The shipped comment names "Cancel transfer" / "Retry" explicitly so a future contributor searching for those features hits the warning.
**Score**: informational

## Location

- [`supabase/migrations/20260412000006_create_rls_policies.sql:86-105`](../../supabase/migrations/20260412000006_create_rls_policies.sql)

## Decision

Today's design is correct: all status mutations go through service_role API routes. But a contributor adding a browser "Cancel transfer" or "Retry" button via the Supabase JS client would silently no-op (UPDATE blocked by RLS without a policy; PostgREST suppresses the rejection).

## Recommendation

Add a `COMMENT ON TABLE` that calls out the architectural invariant. Bundle with PR 7.

## Implementation (in PR 7)

```sql
COMMENT ON TABLE public.book_transfers IS
  'Queue for EPUB transfers from web to device — storage is temporary. '
  'RLS allows authenticated browsers to SELECT (status UI) and (currently) '
  'INSERT (initiate, but see PR 2 — INSERT policy may be dropped). '
  'UPDATE and DELETE are deliberately not granted to authenticated; all '
  'mutations (status changes, cancel, retry) MUST go through API routes '
  'using service_role. Adding a browser-side write via Supabase JS will '
  'silently no-op; PostgREST does not error on RLS rejection.';
```

---

# Issue L1 — `get_highlight_feed` cursor pagination drops books with NULL `book_title` / `book_author`

**Status**: merged ([#31](https://github.com/librito-io/web/pull/31))
**Score**: 78
**Severity**: Polish (correctness edge case)
**Suggested PR**: 5 (shipped)

## Implementation note (added 2026-04-29)

The cursor _generation_ sites (`jsonb_build_object('t', n.book_title, ...)` and the author-sort equivalent) were also wrapped in `COALESCE(..., '')` so emit-and-consume agree on empty string for missing metadata — never JSON null. SQL-side `COALESCE(p_cursor->>'t', '')` would tolerate either form, but matching at the build site keeps the contract tight and means the client-side `encodeCursor`/`decodeCursor` (`src/lib/feed/cursor.ts`) needs no change — it already round-trips whatever the RPC emits. Verified locally: page 1 of `?sort=title` against a NULL-title book emits `"t": ""`, page 2 advances past it correctly. Same for author sort.

## Location

- [`supabase/migrations/20260415000002_create_highlight_feed.sql:101-115`](../../supabase/migrations/20260415000002_create_highlight_feed.sql) — original
- [`supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql:170-188`](../../supabase/migrations/20260426000002_filter_deleted_notes_in_rpcs.sql) — re-issued with same logic

## Why it matters

`books.title` and `books.author` are nullable. Cursor filter for `'title'` / `'author'` sorts uses tuple comparison `(book_title, ...) > (cursor_t, ...)`. When `book_title` is NULL, the comparison evaluates UNKNOWN, filtering the row out.

`ORDER BY ... NULLS LAST` puts NULL-title rows after non-NULL ones in display order, but the cursor never advances past them — they become invisible to pagination after the first page that crosses them.

Edge case but real. Books with missing metadata exist (device sends what the EPUB provides; not all EPUBs have full title/author).

## Recommendation

Wrap the comparison value in `COALESCE` (or a sentinel) so NULLs sort consistently. Apply both in `ORDER BY` and in the cursor tuple.

## Implementation

Bundle with P1 + P2 in PR 5. In the rewritten `get_highlight_feed`:

```sql
-- Replace bare `book_title` and `book_author` in cursor comparisons + ORDER BY
-- with COALESCE(book_title, '') and COALESCE(book_author, '').
-- Empty string sorts before any non-empty string in ASC, matching NULLS LAST
-- intuition for missing metadata.

WHEN 'title' THEN
  p_cursor IS NULL
  OR (COALESCE(book_title, ''), chapter_index, start_word, highlight_id) >
     (COALESCE(p_cursor->>'t', ''),
      (p_cursor->>'c')::smallint,
      (p_cursor->>'s')::int,
      (p_cursor->>'id')::uuid)
```

And in `ORDER BY`:

```sql
CASE WHEN p_sort = 'title' THEN COALESCE(book_title, '') END ASC,
```

(Same for `author`.)

## Acceptance

- [ ] `npm run check` clean
- [ ] `npx vitest run` clean
- [ ] Add or update a vitest unit covering: feed sorted by title with at least one NULL-title book — book appears in pagination, cursor advances past it
- [ ] Local manual: load `/app/feed?sort=title` with seeded data including a NULL-title book — book renders + Load More retrieves remaining pages

## Open questions

- The cursor JSON encoding (`p_cursor->>'t'`) returns text — `COALESCE(p_cursor->>'t', '')` is straightforward. Verify that the client serialises `null` titles into the cursor consistently (i.e., the cursor on a NULL-title row stores `'t': ''` not `'t': null`). May require a small client-side change too.

## Dependencies

- Bundle with P1 + P2 in PR 5.

---

# Issue L2 — `valid_word_range CHECK (end_word > start_word)` rejects single-word highlights

**Status**: merged — Path B ([#35](https://github.com/librito-io/web/pull/35))
**Score**: 55

## Location

- [`supabase/migrations/20260412000003_create_content_tables.sql:57`](../../supabase/migrations/20260412000003_create_content_tables.sql)
- [`supabase/migrations/20260429000007_allow_single_word_highlights.sql`](../../supabase/migrations/20260429000007_allow_single_word_highlights.sql) (fix, staged 2026-04-29)

## Verification finding (2026-04-29)

Firmware uses **inclusive bounds**: `end_word` is the index of the last selected word, not one past it.

- `reader/src/ui/screens/SelectionManager.cpp:257` filters layout words with `providerIndex < lo || providerIndex > hi` — closed interval, both endpoints inclusive.
- `reader/test/unit/screens/SelectionManagerTest.cpp:240-241` (`test_getResult_singleWord`) asserts `startWordIndex == 2 && endWordIndex == 2` for a long-press + immediate Save.
- `reader/src/cloud/SyncPayloadBuilder.cpp:227-228` forwards the indices unchanged.

Single-word selection is a real, reachable feature (long-press a word → tap Save without dragging). The current `>` constraint rejects every such row at the DB layer. Path B applies.

Local DB pre-fix: `min(end_word - start_word) = 45` across 3 rows — relaxation is monotonically safe.

## Resolution — Path B (constraint relaxation + API guard fix)

Migration `20260429000007_allow_single_word_highlights.sql` drops `valid_word_range` and re-adds it as `CHECK (end_word >= start_word)`, plus `COMMENT ON CONSTRAINT` documenting the inclusive semantics and the firmware source line.

`>=` is monotonically safe: every row that satisfied `end_word > start_word` also satisfies `end_word >= start_word`.

Paired API-layer fix in the same commit: `src/lib/server/sync.ts:197` (live highlights) and `:294` (delete-log entries) carried the same exclusive-bounds off-by-one (`endWord <= startWord` rejected). Both relaxed to `<` and error messages updated to "must not be less than startWord". Without this, single-word highlights still bounced at the API layer before reaching the now-permissive DB constraint. New positive cases added to `tests/lib/sync.test.ts` covering single-word live + deleted highlights; the existing negative case renamed from `endWord <= startWord` to `endWord < startWord`.

---

# Issue L3 — `notes` has 4 separate per-action policies (could be `FOR ALL`)

**Status**: future-only
**Score**: 40

Functionally identical to one `FOR ALL` policy. Existing migration is shipped + immutable; consolidation only relevant for any future `notes`-touching policy migration. If S5 happens (drop DELETE policy), three remain — not three down to one ALL, since the read pattern still uses the named SELECT.

No action this cycle. Future `notes` RLS migrations should consider the consolidated form.

---

# Issue L4 — Duplicated `pg_publication_tables` idempotency guard across realtime migrations

**Status**: future-only
**Score**: 35

Both `20260426000001_notes_tombstones_and_realtime.sql` and `20260426000003_enable_realtime_book_transfers.sql` use the same `DO $$ ... ALTER PUBLICATION supabase_realtime ADD TABLE ... $$` idempotency guard.

For future Realtime publication adds, consider extracting once to a helper function `public.ensure_realtime(regclass)`:

```sql
CREATE OR REPLACE FUNCTION public.ensure_realtime(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = split_part(p_table::text, '.', 1)
      AND tablename = split_part(p_table::text, '.', 2)
  ) THEN
    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %s', p_table);
  END IF;
END;
$$;
```

Then `SELECT public.ensure_realtime('public.notes');` from each migration. Lower priority. Don't refactor existing migrations (immutable). Adopt for next add.

---

# Issue L5 — `cover_cache.id` column unused

**Status**: skip
**Score**: 30

All lookups use `isbn UNIQUE`. Column may be referenced by a future FK or by ORM expectations. Tiny storage cost. Not worth migration churn.

---

# Verified non-issues

The following surfaced during review and were investigated but ruled out. Recorded here so a future review doesn't re-flag them.

- **N1**: `pairing_codes` RLS enabled, no anon policy — correct, service_role only.
- **N2**: `cover_cache` SELECT policy after `20260427000002_drop_cover_cache_select_policy.sql` — table-level "Any authenticated user can read covers" still present (the dropped policy was a different storage.objects policy with the same human-readable name).
- **N3**: `cover_cache` no INSERT/UPDATE/DELETE policies — correct, service_role writes.
- **N4**: `get_highlight_feed` `COUNT(*) OVER ()` — bounded by `LIMIT v_limit` (max 100).
- **N5**: `notes` `idx_notes_sync (user_id, updated_at)` no partial filter — correct, sync needs tombstones.
- **N6**: `20260418000001` `'Pocket Reader' → 'Librito'` — correctly idempotent.
- **N7**: `increment_transfer_attempt` `last_error` string concat — `int` parameter, no injection.
- **N8**: `increment_transfer_attempt` empty TABLE return when status changed — caller-side handling, not SQL bug.
- **N9**: `scrub-retired-transfers` race with confirm endpoint — 24 h gate eliminates window.
- **N10**: `valid_transfer_status` constraint coverage — all 4 statuses listed.
- **N11**: `update_updated_at` `SET search_path = ''` — `CREATE OR REPLACE` updated body in place; covers all triggers.
- **N12**: `seed.sql` `v_hl*_id` symmetry — necessary for `notes` INSERTs.
- **N13**: `seed.sql` doesn't set `notes.deleted_at` — defaults to NULL (live), correct.
- **N14**: Nested `(SELECT auth.uid())` inside `IN (SELECT…)` — advisor pattern is uniform, leave as-is.
- **N15**: `CASE WHEN p_sort = …` repeated in `ORDER BY` — canonical Postgres dynamic-ORDER idiom.
- **N16**: `cron.unschedule(jobid) WHERE jobname = …` pattern — idempotent, correct.
- **N17**: `pg_catalog.now()` schema-qualified in `update_updated_at` — required when `search_path = ''`.
- **N18**: `get_highlight_feed` `p_book_hash` filter — `h.user_id = v_uid` anchors, no cross-user leak.
- **N19**: `get_library_with_highlights` drop in `20260415000002`, resurrect in `20260426000002` — likely intentional resurrection for filtered-notes patch. Verify by greping `src/` for `rpc('get_library_with_highlights')` usage during the gap window.
- **N20**: `pairing_codes.hardware_id` over-indexed — tiny table, advisor sign-off worth more than bytes.

---

# Notes on the review process

- **Subagent permission anomaly**: during the review, several Read tool calls inside spawned subagents were silently denied despite the user-level allow rule `Read(//Users/nathanfushia/**)`. No deny rules in any settings file, no hooks on Read. Cause unclear. Workaround: bugs/logic sweep was completed in the main session instead. If future reviews encounter the same issue, fall back to main-session reads or check for subagent-specific permission scoping changes in newer Claude Code releases.
- **`get_library_with_highlights` gap window** (N19 above): the function was dropped on 2026-04-15 (`20260415000002`) and re-created on 2026-04-26 (`20260426000002`). Production code referencing it during that 11-day window would have 404'd. Worth a quick `git log -p src/ -- *.ts | grep -i get_library_with_highlights` between those dates to confirm no caller existed. If no caller during the gap, consider whether the resurrection is needed at all — the recent code path likely uses `get_highlight_feed` for everything.

---

# Follow-ups discovered during PR 3 (S3)

## F1 — Pass C orphan reconciler likely obsolete after S3 fix

The Vercel sweep code's inline comment in `src/routes/api/cron/transfer-sweep/+server.ts:43-45` defers orphan reconciliation to a hypothetical "Pass C (future workstream)". With S3's fix in `20260429000002_pg_cron_scrub_no_storage_path.sql`, pg_cron only nulls `filename`/`sha256` after the Vercel sweep has cleared `storage_path`, so an orphan now requires either (a) the Storage delete itself silently failing in Pass A or (b) Pass A never running for ≥24 h. (a) is an incident, not a leak; (b) is a scheduler outage. The comment should be re-worded ("orphans now require both the Storage delete and the row update to fail" or similar) — defer to a tiny doc-only PR rather than touching application code from this migration-only PR.

## F2 — `attempt_count` / `last_error` populated rows still scrub fine

WS-D (planned) will start populating `attempt_count` and `last_error`. Those columns are not in the scrub `SET` clause and are unrelated to `storage_path`, so this fix is forward-compatible with WS-D. No action needed; recorded for the WS-D session's benefit.
