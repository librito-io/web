# Sentry Operator Runbook

_Last updated: 2026-05-21_

This runbook covers the librito.io deploy's use of Sentry for operator-facing error alerting. Self-hosters running their own Sentry instance can use this as a template but should substitute their own org/project names and alert destinations.

## Where alerts fire

- **Sentry project:** [sentry.io/organizations/librito/projects/librito-web/](https://sentry.io/organizations/librito/projects/librito-web/)
- **Alert email destination:** Sentry user's account email (currently `nathanfushia@icloud.com`). Configured in Sentry → Settings → Account → Notifications → Issue Alerts.
- **Trigger:** Sentry's default "new issue" rule. Fires once when an error signature (message + stack trace hash) is first seen. Subsequent occurrences in the same group increment the count silently — no second email until the group is resolved and recurs.
- **Frequency expectation:** Production should produce ~0 events per week in steady state. A new email = real signal.

## What an alert email looks like

Subject: `[librito-web] New: <error message> (production)` or similar.

Body includes:

- Error message
- Stack trace (first frame + a few more)
- Tags: `environment` (production / preview), `release` (commit SHA), and `wait_until: true` if it originated inside a `runInBackground` callback. Self-test events have an error message matching `sentry-smoke-test-*`.
- Direct link to the issue in the Sentry dashboard.

## How to triage

1. **Open the issue in Sentry.** Click the link in the alert email or navigate to the project's Issues view.
2. **Check the `environment` tag.** Production failures are the priority. Preview-deploy failures (PR builds) are usually intentional during development — confirm with the relevant PR before treating as a real bug.
3. **Check the `release` tag.** It's the commit SHA of the deploy that triggered the throw. `git show <sha>` shows the deploy boundary; recent deploys correlate to recent bug introductions.
4. **Read the stack trace.** With source maps uploaded (production builds only), frames show TypeScript file + line.
5. **Tag interpretation:**
   - `wait_until: true` → originated inside `runInBackground` (`src/lib/server/wait-until.ts`). Background work failure — user request returned 200, the background job silently failed. This is the class of issue #214 / issue #219.
   - Error message matching `sentry-smoke-test-*` → operator-triggered self-test (`/api/cron/sentry-smoke`). Not a real failure; ignore or use to verify the alert pipeline still works.
   - Neither tag → unhandled error from a page load, server action, API route, or other server entry point. Captured by SvelteKit's `handleError` hook wrapped with `Sentry.handleErrorWithSentry()`.

## How to acknowledge

- **Sentry "Resolve" button** on the issue page. Marks the issue resolved. If the same signature recurs in a later deploy, Sentry auto-reopens it with a `regression` tag.
- **"Resolve in next release"** option resolves the issue contingent on a future deploy not reintroducing it — useful when you've shipped a fix and want Sentry to auto-verify by tracking the next `release` tag.
- **"Archive"** for issues you've intentionally chosen not to fix (rare; document the reason in the issue's notes if you use it).

## Cron observability

### transfer-sweep monitor

The daily 03:00 UTC `transfer-sweep` cron is wrapped in `Sentry.withMonitor` (see `src/routes/api/cron/transfer-sweep/+server.ts`). On the Sentry dashboard:

- **Where:** Sentry project → **Crons** in the left nav → look for the `transfer-sweep` monitor. The monitor auto-creates on the first successful check-in after PR 1 deploys.
- **Green tick** in the timeline = the sweep ran and the callback returned. **Red tick** = the callback threw.
- **"Missed check-in" alert** fires when no check-in arrives within the configured `checkinMargin` (5 minutes) past the expected fire time. Causes: Vercel cron schedule drift, deploy with broken cron config, or the route auth/probe gate failing on every fire.
- **"Max runtime exceeded" alert** fires when the sweep runs longer than `maxRuntime` (10 minutes). Usually means Pass C blob backlog (a flood of pending+unverified rows). Inspect with: `SELECT count(*) FROM public.book_transfers WHERE status='pending' AND sha256_verified IS NULL;`
- **`failureIssueThreshold: 1`** = first failure creates an issue. **`recoveryThreshold: 1`** = one successful fire after a failure resolves the issue.

Why Pass C per-row failures do NOT mark the monitor red: a partial Pass C run (some rows downloaded, some not) is still a successful sweep — Pass A and Pass B already completed. Only Pass A select, Pass B delete, or Pass C select failures throw and fail the monitor. Pass C per-row download/hash failures continue to log-and-continue.

### pg-cron-health alerts

The daily 09:00 UTC `pg-cron-health` cron (`src/routes/api/cron/pg-cron-health/+server.ts`) runs a 7-day failure scan against `cron.job_run_details` via the `pg_cron_failure_summary` SECURITY DEFINER function. If any job has failures > 0, the route fires `Sentry.captureMessage("pg_cron_failures_detected", …)`.

**What an alert looks like:**

- **Issue title:** `pg_cron_failures_detected`
- **Tag:** `source: pg_cron_health`
- **Extra:** `{ failures: [{ jobname, failures }, …], windowDays: 7 }`

**Triage steps:**

1. Open the issue → check the `extra.failures` array for the failing job name(s) + count(s).
2. In Supabase Studio (or `psql`), run:
   ```sql
   SELECT start_time, status, return_message
     FROM cron.job_run_details jrd
     JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE j.jobname = '<failing-jobname>'
      AND status != 'succeeded'
      AND start_time > now() - interval '7 days'
    ORDER BY start_time DESC
    LIMIT 20;
   ```
3. Inspect the most recent `return_message` for the underlying error class.
4. Resolve in Sentry once the root cause is fixed and the next cron fire succeeds.

**False positives to expect:**

- A migration that intentionally drops a job leaves a failure tail in `cron.job_run_details` until 7 days pass. Resolve the Sentry issue manually; it auto-archives if no new failures arrive.
- A retried-and-succeeded pattern (1 failure followed by 1 success on next fire) still reports `failures: 1` for 7 days. Acceptable noise; the alert means "look once", not "page".

**Why not Sentry.withMonitor on pg-cron-health?** Free Sentry tier provides one cron monitor slot total, allocated to `transfer-sweep` (higher-impact silent failure surface). A pg-cron-health silent failure reverts to the pre-#190 unobserved state — acceptable risk at pre-launch scale.

(Optional one-time setup) Sentry dashboard → project → **Alerts** → add a per-issue rule for tag `source: pg_cron_health` to batch or mute email if the noise level becomes excessive. Without this, every distinct pg_cron failure pattern fires an email on first occurrence (usually correct behavior).

### Preview deploys do NOT auto-fire Vercel crons

Vercel only triggers `crons[]` paths on **production** deploys. Preview deploys' cron paths are reachable via manual `curl` for smoke verification (the auth gate still applies), but they will not fire on schedule. A broken cron handler on a preview deploy won't surface in Sentry's Crons UI until the production deploy lands.

For preview-deploy verification, manually curl each cron path. The deploy-time `smoke` job already exercises `?probe=1` reachability against the production deploy URL; for a real fire test on preview, omit `?probe=1` and check the Sentry dashboard in the next few minutes for the expected check-in (transfer-sweep) or alert (pg-cron-health when a failure row has been seeded — see the preview smoke procedure in `docs/superpowers/plans/2026-05-21-sentry-phase-2.md` Task 7).

## Client-side error capture

### Toggle

- **Enable:** Set `PUBLIC_SENTRY_DSN` in Vercel production + preview env. **Type: Encrypted (NOT Sensitive).** Sensitive vars are redacted to empty strings by `vercel pull`, breaking the `PUBLIC_*` publishing path.
- **Value:** Same DSN as the existing `SENTRY_DSN` server-side variable. The DSN is designed by Sentry to be publicly exposed in browser bundles.
- **Disable:** Unset `PUBLIC_SENTRY_DSN` and redeploy. `src/hooks.client.ts` gates `Sentry.init` on its presence — unset → no events sent → no bundle init.

### One-time dashboard setup

Sentry org → **Settings** → **Security & Privacy** → enable **"Prevent Storing of IP Addresses"** toggle. Must be done once per Sentry org. Without it, Sentry stores the connecting IP on every event regardless of `sendDefaultPii: false` (which only prevents _enrichment_, not _connection metadata_).

### What client events look like

- **Tag `runtime: browser`** distinguishes client events from server (server events have no `runtime` tag).
- **Release** tag = the deploy SHA. Same SHA appears on server-side events of the same deploy → use the SHA to link a client crash to a same-deploy server fault when triaging.
- **Breadcrumbs panel** in the event detail shows the last ~50 actions: navigations, fetch calls (URL only — auth headers stripped by Sentry SDK), console messages.
- **User context** populated with `{ id: <supabase-uuid> }` when the user is signed in. Never `email`.
- **No `user.ip_address` field** in the event detail (Sentry strips it before storage thanks to the org-level toggle).

### Triage

Same flow as server-side errors:

1. Open issue → check `environment` (preview vs production) and `release` tag.
2. Read stack trace — production stacks map to TypeScript source via uploaded source maps.
3. Inspect breadcrumbs for the fetch call / navigation sequence leading to the throw.
4. Reproduce locally with the same browser + route.
5. Resolve in Sentry once fixed.

### Bundle-size impact

`@sentry/sveltekit` browser bundle with default integrations: ~40-60 KB gzip on the initial page load. Default integrations (`BrowserApiErrors`, `Breadcrumbs`, `GlobalHandlers`, `LinkedErrors`, `HttpContext`, `Dedupe`) stay ON because they provide the high-value debug signal that justifies client capture in the first place.

### Smoke test (post-deploy)

In a browser DevTools console on the deployed site:

```js
setTimeout(() => {
  throw new Error("client-smoke-test");
}, 0);
```

Within ~30 seconds an issue appears with:

- Error message: `client-smoke-test`
- Tag: `runtime: browser`
- No `user.ip_address` in the event detail
- If you were signed in: `user.id` present (Supabase UUID), `user.email` absent

Reproduce signed-in vs anonymous to confirm both paths.

## How to run an ad-hoc health check

The smoke endpoint deliberately fires an event into the Sentry pipeline so you can verify alerts still arrive end-to-end.

```bash
curl -X POST https://librito.io/api/cron/sentry-smoke \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected response: `202 {"scheduled": true, "id": "<8-char-id>"}`.

Within ~30 seconds: a Sentry issue appears with error message `sentry-smoke-test-<id>` and tag `wait_until: true`.

Within ~1 minute: the alert email arrives in the operator inbox (only the first event in a smoke-test group triggers email; subsequent runs increment the count without emailing, unless you "Resolve" the issue in between).

## Reducing smoke-event noise (one-time setup)

In Sentry → Project Settings → Inbound Filters (or Alerts → per-issue rule, whichever the SDK version offers), create a rule that ignores events whose error message starts with `sentry-smoke-test-`:

> When an event's `message` contains `sentry-smoke-test-` → set issue state to Ignored / suppress notifications.

Without this rule, every health-check curl would re-trigger an email. The default "new issue" rule fires only on the first event in a group, but if you "Resolve" smoke issues to keep the dashboard clean, the next smoke run looks like a "regression" and re-pages.

(The smoke events all share the same error message prefix `sentry-smoke-test-<id>`. Sentry's issue grouping by message + stack signature buckets them under one issue, so the rule operates per-bucket, not per-curl. The 8-char unique `<id>` suffix lets the operator correlate each curl invocation with the exact event Sentry stored, even though Sentry groups them.)

## Rotating the Sentry DSN

If you ever need to rotate the DSN (project compromised, separating environments, etc.):

1. In Sentry → Project Settings → Client Keys (DSN) → create a new key, disable the old key.
2. Update `SENTRY_DSN` in Vercel production + preview env (Sensitive type, both targets).
3. Wait for the next deploy or trigger a redeploy. The new DSN takes effect on next cold start.
4. Run the ad-hoc health check above to confirm events reach Sentry through the new DSN.

## Rotating the auth token

If `SENTRY_AUTH_TOKEN` needs rotation (compromised, scope change, etc.):

1. Sentry → Org Settings → Auth Tokens (Org tokens, NOT personal) → create new, delete old.
2. Update `SENTRY_AUTH_TOKEN` in Vercel production + preview AND GitHub Actions secrets (`gh secret set SENTRY_AUTH_TOKEN`).
3. Next production deploy uses the new token for source-map upload. Preview builds via Vercel infra pick it up on next push.

## Disabling Sentry temporarily

To silence all Sentry reporting from librito.io (e.g. during a known-noisy migration):

```bash
npx vercel env rm SENTRY_DSN production
npx vercel env rm SENTRY_DSN preview
# Redeploy to take effect
```

The SDK gates `Sentry.init` on `SENTRY_DSN` presence — unset → no-op, no events sent. Restore by adding the env back.

## Common false positives to watch for

- **Smoke events** without the muting rule (see above).
- **Preview-deploy errors during active development** — preview env captures everything, including deliberate experimental throws. Filter the dashboard by `environment: production` for the load-bearing signal.
- **Deploy-time transient errors** — first few requests after a new deploy may hit edge-case failures (e.g. cold-start race with external services). One-offs that don't recur after the next deploy are usually noise.
