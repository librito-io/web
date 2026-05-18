# Sentry Operator Runbook

_Last updated: 2026-05-18_

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
- Tags: `environment` (production / preview), `release` (commit SHA), and `wait_until: true` if it originated inside a `runInBackground` callback, or `smoke: true` for self-test events.
- Direct link to the issue in the Sentry dashboard.

## How to triage

1. **Open the issue in Sentry.** Click the link in the alert email or navigate to the project's Issues view.
2. **Check the `environment` tag.** Production failures are the priority. Preview-deploy failures (PR builds) are usually intentional during development — confirm with the relevant PR before treating as a real bug.
3. **Check the `release` tag.** It's the commit SHA of the deploy that triggered the throw. `git show <sha>` shows the deploy boundary; recent deploys correlate to recent bug introductions.
4. **Read the stack trace.** With source maps uploaded (production builds only), frames show TypeScript file + line.
5. **Tag interpretation:**
   - `wait_until: true` → originated inside `runInBackground` (`src/lib/server/wait-until.ts`). Background work failure — user request returned 200, the background job silently failed. This is the class of issue #214 / issue #219.
   - `smoke: true` → operator-triggered self-test (`/api/debug/sentry-smoke`). Not a real failure; ignore or use to verify the alert pipeline still works.
   - Neither tag → unhandled error from a page load, server action, API route, or other server entry point. Captured by SvelteKit's `handleError` hook wrapped with `Sentry.handleErrorWithSentry()`.

## How to acknowledge

- **Sentry "Resolve" button** on the issue page. Marks the issue resolved. If the same signature recurs in a later deploy, Sentry auto-reopens it with a `regression` tag.
- **"Resolve in next release"** option resolves the issue contingent on a future deploy not reintroducing it — useful when you've shipped a fix and want Sentry to auto-verify by tracking the next `release` tag.
- **"Archive"** for issues you've intentionally chosen not to fix (rare; document the reason in the issue's notes if you use it).

## How to run an ad-hoc health check

The smoke endpoint deliberately fires an event into the Sentry pipeline so you can verify alerts still arrive end-to-end.

```bash
curl -X POST https://librito.io/api/debug/sentry-smoke \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected response: `202 {"scheduled": true, "id": "<8-char-id>"}`.

Within ~30 seconds: a Sentry issue appears with error message `sentry-smoke-test-<id>` and tags `wait_until: true`, `smoke: true`.

Within ~1 minute: the alert email arrives in the operator inbox (only the first event in a smoke-test group triggers email; subsequent runs increment the count without emailing, unless you "Resolve" the issue in between).

## Reducing smoke-event noise (one-time setup)

In Sentry → Project Settings → Alerts, create a per-issue rule:

> When an event's tags include `smoke = true` → set issue state to Ignored / suppress notifications.

Without this rule, every health-check curl would re-trigger an email. The default "new issue" rule fires only on the first event in a group, but if you "Resolve" smoke issues to keep the dashboard clean, the next smoke run looks like a "regression" and re-pages.

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
