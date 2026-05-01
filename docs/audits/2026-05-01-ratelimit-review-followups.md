# Ratelimit Fail-Mode Branch Review — Follow-up Fixes (2026-05-01)

Source-of-truth for fix work that came out of `/branch-review` on `feat/ratelimit-fail-mode-policy`. Each issue is a self-contained section a future session can pick up cold.

## Context

- **Trigger**: `/branch-review` run 2026-05-01 against `feat/ratelimit-fail-mode-policy` (7 commits ahead of `main`).
- **Scope reviewed**: rate-limit refactor — `createLimiter` factory, `enforceRateLimit` / `enforceRateLimits` enforcement API, explicit fail-closed/fail-open policy, Redis call timeout, removal of legacy `safeLimit` / `passThroughSafeLimit`. 9 routes migrated (`/api/sync`, `/api/pair/{request,status,claim}`, `/api/transfer/{initiate,[id]/{confirm,download-url,retry}}`, `/api/realtime-token`).
- **Reviewers**: 5 parallel agents (CLAUDE.md compliance, bugs/logic, security, types/perf/quality, simplification) + main-session verification reads against current HEAD.
- **Calibration**: branch-review (looser than existing-code — ship-correctness baseline). Confidence ≥ 80 surfaced as Critical/Warning during the live review; this audit reopens every finding regardless of score for OSS-grade follow-up.
- **Filtering**: 13 fix candidates, 2 explicit skips, 9 excluded as non-issues / pre-existing / out of branch scope. Exclusions documented at the end.
- **OSS lens applied throughout**: bias toward self-documenting code, tests-as-docs against real production code paths, explicit policy rationale at point of definition, type-system enforcement over convention. The branch ships correct; this audit hardens contract surfaces before public exposure.

## Workflow

1. **One session per fix group** (small focused PRs squash-merge cleanly into archeology).
2. **Each session opens with** "read `docs/audits/2026-05-01-ratelimit-review-followups.md`, work on issue X" (or a group: `Refactor`, `Tests`, `Polish`).
3. **Session reads the issue section + the referenced source files**, implements TDD-style per CLAUDE.md, opens PR.
4. **Before session closes**: update the Status table here with PR link + status. Add follow-ups discovered during implementation as new sections.

## Status overview

| #   | Issue                                                                                  | Severity              | Score | PR                                               | Status                     | Session date |
| --- | -------------------------------------------------------------------------------------- | --------------------- | ----- | ------------------------------------------------ | -------------------------- | ------------ |
| R1  | `safeLimit` discriminated-union refactor (eliminates synthetic struct + 2 `as` casts)  | Refactor (types)      | ~50   | [#50](https://github.com/librito-io/web/pull/50) | in-review                  | 2026-05-01   |
| T1  | `enforceRateLimits` Promise.all → sequence per-device → per-user; log on partial drain | Warning (bug/UX)      | 85    | —                                                | open                       | —            |
| C1  | Cast `as LimitResult[]` at `ratelimit.ts:231` → type-predicate filter                  | Warning (types)       | 87    | [#50](https://github.com/librito-io/web/pull/50) | in-review (subsumed by R1) | 2026-05-01   |
| K1  | Extract `FAIL_CLOSED_RETRY_AFTER_SEC` to `ratelimit.constants.ts`; consume in tests    | Warning (test drift)  | 75    | —                                                | open                       | —            |
| H1  | Replace `_RateLimiter` mock type with `import type { RateLimiter }`                    | Warning (types/drift) | 72    | —                                                | open                       | —            |
| M1  | Migrate route tests to real `enforceRateLimits` + delete pass-through helpers          | Warning (test arch)   | 68    | —                                                | open                       | —            |
| P1  | Flip `pairRequestLimiter` to `failMode: "closed"`                                      | Policy (avail)        | 32    | —                                                | open                       | —            |
| D1  | WHY-comment for `transferConfirmLimiter` fail-open rationale                           | Doc                   | info  | —                                                | open                       | —            |
| D2  | Refresh stale AbortSignal-era comment in `safeLimit`                                   | Doc                   | ~30   | —                                                | open                       | —            |
| TG1 | Add `enforceRateLimits` test: fail-open throws while fail-closed allows                | Test gap              | 72    | —                                                | open                       | —            |
| TG2 | Add `enforceRateLimits` × timeout multi-limiter test                                   | Test gap              | ~35   | —                                                | open                       | —            |
| SK1 | `isFailClosed` `in`-check vs Symbol-keyed sentinel                                     | Skip                  | ~25   | —                                                | skip                       | —            |
| SK2 | `passThroughEnforceRateLimits` filter chain density                                    | Skip                  | ~25   | —                                                | skip                       | —            |

## Suggested execution order

R1 first — its discriminated-union cascades into C1 and removes the cast inside the synthetic struct. T1 second — biggest UX/observability win at scale. K1 → H1 → M1 — test infrastructure consolidation. P1 — single-line policy flip. TG1, TG2 — coverage. D1, D2 — comment polish. R1 + C1 can land in one PR; T1 standalone; M1 + H1 + K1 + TG1 + TG2 in a "test consolidation" PR; P1 + D1 + D2 in a polish PR.

---

## R1 — `safeLimit` discriminated-union refactor

**Files**: `src/lib/server/ratelimit.ts` (lines ~80–185), `tests/lib/ratelimit.test.ts`, `tests/helpers.ts` (if M1 not yet merged).

**Problem**. `safeLimit` currently returns `LimitResult | FailClosedSentinel`. The fail-open success path uses `syntheticAllowResult()` which returns a `LimitResult` with `success: true, limit: 0, remaining: 0, reset: 0` — semantically "succeeded with zero quota". Two `as` escape hatches paper over the type drift:

- `ratelimit.ts:109` — `as LimitResult` on the synthetic struct (because optional fields aren't structurally inferred).
- `ratelimit.ts:231` — `(results as LimitResult[]).filter(...)` after a non-narrowing `.some(isFailClosed)` check (this is C1; R1 makes C1 disappear for free).

Today nothing reads `remaining` / `limit` on the synthetic value, so the contradiction is latent. As soon as anyone wires quota headers or analytics on `safeLimit`'s output, fail-open paths log "0/0 remaining" indistinguishably from genuinely exhausted buckets.

**Fix**. Replace `safeLimit`'s return with a discriminated union:

```ts
type SafeOutcome =
  | { kind: "ok"; result: LimitResult } // upstream success or deny — read .success
  | { kind: "failClosed"; label: string } // upstream errored, fail-closed policy → caller emits 503
  | { kind: "failOpen"; label: string }; // upstream errored, fail-open policy → caller treats as allow
```

`enforceRateLimit` then switches on `kind` directly; no `success: true` lying about quota state. Update `enforceRateLimits` to:

```ts
const failClosed = outcomes.find((o) => o.kind === "failClosed");
if (failClosed) return jsonError(503, ...);
const denied = outcomes.flatMap((o) =>
  o.kind === "ok" && !o.result.success ? [o.result] : []
);
```

This eliminates `syntheticAllowResult`, the `as LimitResult` cast, and the `as LimitResult[]` cast.

**Acceptance**:

- Zero `as` casts in `ratelimit.ts`.
- `syntheticAllowResult` removed.
- `LimitResult` no longer appears in `safeLimit`'s return type — only in the `ok` arm.
- Existing tests still pass; new test asserts `{ kind: "failOpen" }` outcome shape on a fail-open limiter that throws (so future readers see the contract).

---

## T1 — Sequence `enforceRateLimits` per-device → per-user with partial-drain log

**File**: `src/lib/server/ratelimit.ts:213-238`. Caller of consequence: `src/routes/api/realtime-token/+server.ts`.

**Problem**. `enforceRateLimits` issues `Promise.all` over all limiters. Upstash sliding-window decrements at call time, so tokens are consumed before the result is observed. Concrete pathology on `/api/realtime-token` (uses 2 fail-closed limiters: `realtimeTokenLimiter` per-device 1/60s + `realtimeTokenUserLimiter` per-user 30/h):

1. **Asymmetric Redis blip**: bucket A returns success, bucket B throws → 503 returned, but bucket A's token is already burned. The device cannot mint for the rest of its 60 s window even after Redis recovers, despite the failure being entirely server-side.
2. **Per-device storm drains per-user budget**: a buggy device that hammers its per-device cap also decrements the per-user 30/h bucket on every attempt, locking out sibling devices on the same account for the rest of the hour.

The header comment justifies `Promise.all` on latency grounds. The justification is correct for latency but does not address token-consumption asymmetry. There is no log indicating which scenario occurred — operators see "device locked out" with no causal link to the Upstash blip.

**Fix**. Two changes:

1. **Sequence the checks**: per-device first (the binding constraint at 1/60s is far more likely to deny), then per-user. Short-circuit on the first deny so the loser's token is not consumed.
2. **Structured log on partial drain**: when `enforceRateLimits` returns 503 with ≥1 successful bucket, emit `console.warn("ratelimit.partial_drain", { route, succeededLabels, failedLabel })` so operators can correlate device-locked windows to Upstash blips.

Latency cost of sequencing two REST calls instead of one Promise.all: ~50–100 ms per call on cold path; acceptable for an endpoint that mints once per minute per device.

**Acceptance**:

- `enforceRateLimits` runs `safeLimit` calls sequentially, returning early on the first deny.
- Test added: `realtimeTokenLimiter` denies → `realtimeTokenUserLimiter` is never invoked (assert via spy call count).
- Test added: bucket A success + bucket B throws → 503 returned + `console.warn("ratelimit.partial_drain", ...)` emitted (assert via `vi.spyOn(console, "warn")`).
- Header comment in `enforceRateLimits` updated to document the sequencing rationale (replaces the latency-only justification).

---

## C1 — `as LimitResult[]` cast at `ratelimit.ts:231`

**File**: `src/lib/server/ratelimit.ts:231`.

**Problem**. `const denied = (results as LimitResult[]).filter((r) => !r.success);`. `results` has type `(LimitResult | FailClosedSentinel)[]`; the preceding `.some(isFailClosed)` does not narrow the array element type, so the cast is necessary today. The cast is a type erasure — a future change to `safeLimit`'s return shape would silently slip through.

**Fix**. If R1 is merged first, this cast disappears (C1 is subsumed). If R1 is deferred:

```ts
const denied = results
  .filter((r): r is LimitResult => !isFailClosed(r))
  .filter((r) => !r.success);
```

Predicate filter narrows structurally, no cast.

**Acceptance**:

- No `as` cast at `ratelimit.ts:231`.
- Tests still green.

---

## K1 — Extract `FAIL_CLOSED_RETRY_AFTER_SEC` to constants module

**Files**: `src/lib/server/ratelimit.ts` (constant defined ~line 92, internal), `tests/helpers.ts` (literal `30` at lines 218, 241, 267), route tests asserting `"30"` string.

**Problem**. Literal `30` for fail-closed `Retry-After` is duplicated in 3 places in `tests/helpers.ts`, with a comment explicitly admitting drift risk because the prod constant is not exported. Route tests at `tests/lib/realtime-token.test.ts:262,280` and `tests/lib/pair-claim.test.ts:78` also hardcode `"30"`. If the prod constant changes, mocks silently diverge; tests pass with stale expectations.

`ratelimit.ts` cannot be directly imported in vitest because it imports `$env/static/private`. So the constant has to live in a `$env`-free module.

**Fix**.

1. Create `src/lib/server/ratelimit.constants.ts`:
   ```ts
   export const FAIL_CLOSED_RETRY_AFTER_SEC = 30;
   ```
2. `ratelimit.ts` imports from there (replaces the local `const`).
3. `tests/helpers.ts` imports from there directly (no `$env` dependency, no `vi.mock` needed for this import).
4. Route tests import the constant; assertion becomes `expect(...).toBe(String(FAIL_CLOSED_RETRY_AFTER_SEC))`.
5. Drop the drift-warning comment in `tests/helpers.ts`.

**Acceptance**:

- Zero hardcoded `30` literals related to `Retry-After` in `tests/helpers.ts` and route tests.
- `FAIL_CLOSED_RETRY_AFTER_SEC` is the single source of truth, importable from both prod and test.
- Drift comment removed.

---

## H1 — Replace `_RateLimiter` mock type with imported `RateLimiter`

**File**: `tests/helpers.ts:207-211`.

**Problem**. Local type alias `_RateLimiter` is a hand-rolled structural subset of the exported `RateLimiter` type:

- `limit` returns `Promise<{ success: boolean; reset: number }>` instead of `Promise<LimitResult>` (full shape).
- Missing `readonly` modifiers on `label`, `failMode`.
- Underscore prefix conventionally signals "unused", which is misleading.

Drift hazard: any new required field on `RateLimiter` won't surface a type error in tests.

**Fix**. `import type { RateLimiter } from "../src/lib/server/ratelimit"`. Type-only imports are erased at compile time, so the `$env/static/private` import in `ratelimit.ts` is not triggered. Delete `_RateLimiter`. Update mock factories (`fakeLimiter` etc.) to satisfy the full `RateLimiter` shape — return a complete `LimitResult` from `limit` (the additional `limit`/`remaining`/`pending` fields are trivial to populate).

**Acceptance**:

- `_RateLimiter` removed.
- Test mocks satisfy the production `RateLimiter` type structurally.
- No `import type` at runtime side-effects (vitest still runs without `$env` setup for these tests).

---

## M1 — Route tests use real `enforceRateLimits`; delete pass-through helpers

**Files**: `tests/helpers.ts:240-290` (`passThroughEnforceRateLimit`, `passThroughEnforceRateLimits`), `tests/lib/realtime-token.test.ts`, `tests/lib/pair-claim.test.ts`, any other route test using these helpers.

**Problem**. `passThroughEnforceRateLimits` reimplements the production `enforceRateLimits` algorithm from scratch (`Promise.all` + fail-closed sentinel detect + 429/503 dispatch). Drift risks:

- Helper does not include `isProgrammerError` rethrow that prod `safeLimit` performs — a `RangeError` in a mock would be swallowed as 503 by helper but rethrown in prod.
- 503 message string `"Service temporarily unavailable. Please retry shortly."` is duplicated; prod string change keeps tests green with stale string.
- Any future change to `enforce*` semantics (R1 union, T1 sequencing) requires parallel updates in the helper or tests silently diverge.

The pattern in `ratelimit.test.ts` already calls the real `enforceRateLimits` with mocked limiter instances. Route tests should match.

**Fix**.

1. Migrate each route test to construct mock limiter instances (using `RateLimiter` shape from H1) and call the real `enforceRateLimit` / `enforceRateLimits`.
2. Delete `passThroughEnforceRateLimit` and `passThroughEnforceRateLimits` from `tests/helpers.ts`.
3. Where route tests need to inject a stub limiter without touching the module-scoped exports, use `vi.mock("$lib/server/ratelimit", ...)` to substitute the named export with a test-controlled `createLimiter(...)` instance.

**Acceptance**:

- `passThroughEnforceRateLimit*` exports gone.
- Route tests exercise real `enforceRateLimits` code path.
- A grep for `passThroughEnforceRateLimit` returns zero results in `tests/`.
- Tests still pass; coverage improves on the actual prod code path.

Subsumes part of D2 from C1 cascade and naturally benefits from R1 (real union shapes assert the contract).

---

## P1 — Flip `pairRequestLimiter` to `failMode: "closed"`

**File**: `src/lib/server/ratelimit.ts` (`pairRequestLimiter` definition, ~line 241).

**Problem**. `pairRequestLimiter` is currently `failMode: "open"`. `/api/pair/request` is **unauthenticated**. `requestPairingCode` (`src/lib/server/pairing.ts:36-65`) does plain `INSERT` per `hardware_id` — the unique index `idx_pairing_codes_unclaimed` covers `code` (not `hardware_id`), so multiple unclaimed rows per `hardware_id` are allowed, bounded only by the 5-minute TTL.

During an Upstash outage, an attacker rotating UUIDs can flood `pairing_codes` inserts at platform-permitted rate. Blast radius is bounded (5-min TTL, no auth bypass, no data exfiltration), but the endpoint has zero downstream auth gate and the fail-open policy buys availability for _anonymous_ traffic only — which is not a property worth protecting.

**Fix**. Change to `failMode: "closed"`. Cost during outage: anonymous pairing requests temporarily 503 with `Retry-After: 30`. Devices already retry pairing; users hit "try again" once. Aligns with the fail-closed policy used for the other unauthenticated brute-force gate (`pairClaimLimiter`).

**Acceptance**:

- `pairRequestLimiter` is `failMode: "closed"`.
- Existing `ratelimit.policy.test.ts` snapshot updated.
- New WHY-comment at the limiter definition: "fail-closed because endpoint is unauthenticated and writes DB rows; outage cost (anonymous 503) is acceptable; matches `pairClaimLimiter` brute-force-gate policy."

---

## D1 — WHY-comment for `transferConfirmLimiter` fail-open

**File**: `src/lib/server/ratelimit.ts` (`transferConfirmLimiter` definition, ~line 285).

**Problem**. `transferConfirmLimiter` is `failMode: "open"`. The rationale is that `/confirm` is a device-authed endpoint whose downstream `UPDATE ... WHERE status='pending'` is idempotent — replays no-op. Without an inline comment, OSS reviewers must reverse-engineer the policy.

**Fix**. Add a 2-line WHY-comment per CLAUDE.md ("only comment WHY, not WHAT"):

```ts
// fail-open safe — confirm is idempotent guarded UPDATE … WHERE status='pending';
// replays after Upstash recovery no-op. Worst case during outage: device-authed
// attacker burns their own quota for no effect.
```

**Acceptance**: comment present at the limiter definition.

---

## D2 — Refresh stale AbortSignal comment in `safeLimit`

**File**: `src/lib/server/ratelimit.ts:132-135`.

**Problem**. Comment fragment references `AbortSignal` and `AbortController` plumbing as future tech debt, but commit `c87aafc` removed the dead `AbortController`. The "When the SDK gains signal support, plumb it through here" line is fine WHY-rationale; the surrounding sentence reads as leftover context.

**Fix**. Tighten to one sentence stating the current behaviour: "Upstash REST `.limit()` does not accept an `AbortSignal`; a timed-out call resolves in the background and the result is discarded by `Promise.race`."

**Acceptance**: comment is one self-contained sentence; no dangling reference to a removed `AbortController`.

---

## TG1 — `enforceRateLimits` test: fail-open throws while fail-closed allows

**File**: `tests/lib/ratelimit.test.ts` (`enforceRateLimits` describe block, ~lines 282–341).

**Problem**. All three existing `enforceRateLimits` tests use both limiters with `failMode: "closed"`. The contract case "fail-open limiter throws while fail-closed limiter allows → request allowed (null returned)" is not covered. A future refactor of `safeLimit` that mistakenly emits a fail-closed sentinel for a fail-open throw would not be caught.

**Fix**. Add:

```ts
it("returns null when fail-open limiter throws and fail-closed limiter allows", async () => {
  const open = fakeLimiter("open", () => { throw new Error("boom"); });
  const closed = fakeLimiter("closed", () => Promise.resolve({ success: true, ... }));
  const result = await enforceRateLimits([
    { limiter: open, key: "k1" },
    { limiter: closed, key: "k2" },
  ]);
  expect(result).toBeNull();
});
```

**Acceptance**: test exists, asserts `null`, passes after R1 (and would have caught a regression that emitted `failClosed` for the fail-open throw).

---

## TG2 — `enforceRateLimits` × timeout multi-limiter test

**File**: `tests/lib/ratelimit.test.ts` (timeout describe block, ~line 202).

**Problem**. Timeout interaction is tested only for single-limiter `enforceRateLimit`. The multi-limiter case (one bucket hangs past timeout, the other resolves fast) is untested. After T1 (sequencing) the surface is simpler — one bucket times out, sequence aborts — but the test still belongs.

**Fix**. Add: limiter A returns success fast; limiter B `await new Promise(() => {})` (hangs); assert 503 returned + log emitted within timeout window.

**Acceptance**: test exists; assertion uses `vi.useFakeTimers()` and advances past the configured Redis timeout.

---

## SK1 — `isFailClosed` `in`-check vs Symbol-keyed sentinel — SKIP

**File**: `src/lib/server/ratelimit.ts:96-100`.

**Reasoning**. Suggestion was to switch the `FailClosedSentinel` discriminant to a `Symbol` to eliminate the theoretical collision if Upstash's `LimitResult` ever sprouts a top-level `failClosed` field. That collision is implausible (Upstash is not in the business of adding fields named after our internal failure modes), and if it ever happened the union type-check would flag the conflict at the call site. Symbol-keyed sentinels add ceremony for ~zero risk reduction. Kept simple.

After R1, `FailClosedSentinel` is replaced by `{ kind: "failClosed" }` anyway, which is even cleaner and removes this discussion entirely.

---

## SK2 — `passThroughEnforceRateLimits` filter chain density — SKIP

**File**: `tests/helpers.ts:270-274`.

**Reasoning**. Two-step `.filter` with inline type predicate is idiomatic + readable. `flatMap` rewrite is cleverness-not-clarity. Subsumed by M1 (helper is being deleted entirely). Don't churn for taste.

---

## Excluded / verified non-issues

These were investigated and intentionally left off the fix list. Captured here so future reviewers do not re-surface them:

| Item                                                          | Why excluded                                                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing-smoke-pre-merge.ts` claimPairingCode positional call | File is untracked (`?? pairing-smoke-pre-merge.ts` in `git status`), not part of branch diff. Local working artifact. Fix out-of-band before running the smoke or delete the script.                 |
| `getClientAddress()` leftmost `x-forwarded-for` IP-spoof      | Pre-existing across the codebase — refactor would touch every IP-keyed limiter. Worth a separate ticket (`x-real-ip` on Vercel) — not branch scope. Reference: agent finding C4 in branch review.    |
| `pair/claim` compound key `${code}:${ip}` correctly scoped    | Verified key is correctly per-code per-IP for brute-force binding; key omitted from logs (test exists at `ratelimit.test.ts:238`). Positive finding, no action.                                      |
| Stack trace bleed in 503 response                             | Verified `console.error` is server-only; client receives `jsonError` body containing `{ error, message }` only. No info disclosure.                                                                  |
| Stale `safeLimit` exports / dangling references               | Verified clean — `safeLimit` is now an internal (non-exported) helper; all references in tests are string labels in `describe(...)` blocks, not symbol references; no route imports the legacy name. |
| `@upstash/ratelimit` CVE                                      | Branch does not bump version pin (`^2.0.0`, `^1.34.0` unchanged). No new CVE surface.                                                                                                                |
| Login/signup rate limit                                       | Handled by Supabase GoTrue, not by this layer. Out of scope.                                                                                                                                         |
| `enforceRateLimit` vs `enforceRateLimits` N=1 ambiguity       | Documented in JSDoc; only `realtime-token` uses the multi-limiter form (N=2). Intentional. Not confusing in practice.                                                                                |
| Route-handler `if (limited) return limited;` duplicated 9×    | Folding into `withRateLimit(handler, ...)` wrapper is premature abstraction per CLAUDE.md ("don't add helpers beyond what task requires"). Two-line pattern is explicit + correct call.              |
| Sync route `1_048_576` magic number                           | Pre-existing, not part of this branch's diff. Out of scope.                                                                                                                                          |

---

## Notes for future sessions

- `ratelimit.ts` imports `$env/static/private` (Upstash creds). Any vitest module that wants to import from it needs `vi.mock("$env/static/private", () => ({ ... }))` registered before the import. The pattern is already used in `tests/lib/ratelimit.test.ts` and `tests/lib/ratelimit.policy.test.ts` — copy from there.
- TDD per CLAUDE.md: write the failing test first, then change `ratelimit.ts`, verify pass, commit. Especially load-bearing for T1 (sequencing) and R1 (union refactor) because they reshape the public contract.
- Commit messages carry the archeology (squash-merge concatenates). PR body slim per `.github/pull_request_template.md`. Conventional commits — `refactor(ratelimit):`, `test(ratelimit):`, `fix(ratelimit):`, `chore(ratelimit):`.
- After each PR merges, update the Status table here with the PR link + status. If new issues surface during implementation, add a new section.
