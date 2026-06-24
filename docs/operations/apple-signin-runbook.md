# Apple Sign-in Operations Runbook

Sign-in-with-Apple authenticates via a **client-secret JWT** signed with a `.p8`
key. The JWT expires in **≤6 months** — when it lapses, **all** Apple logins
fail silently with no app-side error. This runbook is how we prevent and recover
from that.

## Prerequisites (one-time)

- Apple Developer Program membership ($99/yr) — renewal is itself a hard
  dependency; a lapsed membership kills Apple login.
- **App ID** (primary) with "Sign in with Apple" capability enabled.
- **Services ID** (this is the GoTrue `client_id`, e.g. `io.librito.signin`).
- **Sign-in-with-Apple key** (`.p8`) created under Certificates → Keys; note the
  **Key ID** and your **Team ID**. The `.p8` downloads exactly once.

## Where secrets live

- `.p8` private key + Key ID + Team ID: store in the team password manager
  (1Password), NOT git, NOT a developer laptop long-term.
- The generated client-secret JWT → Supabase Dashboard → Authentication →
  Providers → Apple → "Secret Key (for OAuth)". Mirror to the
  `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` env if self-hosting.
- The Services ID → Supabase Dashboard "Client ID" /
  `SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID`.

## Generating the client-secret JWT

The JWT is an ES256 token signed with the `.p8`, claims:
`iss` = Team ID, `sub` = Services ID, `aud` = `https://appleid.apple.com`,
`iat` = now, `exp` = now + ≤180 days, header `kid` = Key ID.

Use Apple's documented procedure or a small script (ruby/node `jsonwebtoken`).
Set `exp` to **150 days** out (not the 180 max) to leave rotation slack.

## Rotation procedure (every ≤5 months)

1. Generate a fresh client-secret JWT from the stored `.p8` (Key ID, Team ID
   unchanged — the `.p8` itself is long-lived; only the JWT expires).
2. Paste it into Supabase Dashboard → Apple provider → Secret Key.
3. Verify a real Apple sign-in succeeds (see Detection below).
4. Record the new `exp` date and reset the reminder.

## Reminder mechanism (mandatory)

Create a recurring calendar event (team calendar, not personal) titled
"Rotate Apple Sign-in secret — Librito" set to **5 months** from each rotation,
with this runbook linked. Without the reminder, expiry is a silent outage.

## Detection

There is no automated monitor today (Sentry free-tier cron slot is allocated
to `transfer-sweep`). Detection paths:

- A real Apple round-trip in the pre-merge / periodic manual check.
- User reports of "Apple sign-in does nothing."
- If/when a monitor budget exists: a synthetic Apple login probe or a
  calendar-driven manual check ~2 weeks before `exp`.

## Private-relay email

Apple "Hide My Email" returns a `@privaterelay.appleid.com` address. This does
NOT link to a prior email-signup account (different email) — a separate account
results, by design. See spec §5; nothing to do operationally beyond awareness.

## Rollback

If a rotation breaks login, re-paste the previous still-valid JWT (if not yet
expired) from the password manager, then regenerate. Keep the prior JWT until
the new one is verified working.
