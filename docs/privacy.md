# Privacy

_Last updated: 2026-07-01_

Librito stores the minimum data required to synchronise your highlights and notes between your device and the web. This document describes exactly what we store, for how long, and who can reach it.

## What we store

- **Account profile.** Email address and Supabase Auth identifiers, your display name, an internal admin flag, and an account-creation timestamp. Used for login and account management.
- **Book metadata.** Title, author, ISBN, language, and a device-generated 8-hex book hash. No reading progress. No extracted text from your books.
- **Highlights and notes.** The text you highlighted, your optional note, and the chapter / word position. Highlights imported from another source (for example, a Kobo device) instead store character offsets and a source identifier. Scoped to your account.
- **Device state.** Device-token hash, last-sync timestamps, device name.

## What we do not store

- **Reading progress.** No per-book progress, no session telemetry.
- **Analytics or third-party tracking.** No user analytics, no behavioural telemetry. Librito uses Sentry strictly for server-side error reporting to its operator — see the "Operator error tracking" section below.

## Signing in with Google or Apple

Librito offers sign-in with Google and Apple alongside email sign-in. If you use one:

- The provider authenticates you and passes a basic profile to Librito — your email address, a provider-issued account identifier, and your name if the provider includes it. This is handled by Supabase Auth and stored with your account.
- Librito never receives your Google or Apple password.
- Apple's "Hide My Email" is supported. If you use it, Librito only ever sees the private relay address Apple generates, not your real email address.
- Google and Apple process the sign-in under their own privacy policies.

Librito does not post to, read from, or otherwise access your Google or Apple account beyond this one-time sign-in exchange.

## Operator error tracking

Librito sends server-side error events (unhandled exceptions, including failures inside background jobs) to Sentry, a third-party error-tracking processor. These events power operator alerting — the goal is to find out about a server bug in minutes instead of weeks.

Before any event is sent, the following fields are stripped or redacted in code:

- HTTP `Authorization` and `Cookie` headers are removed entirely.
- Field values named `token`, `api_token_hash`, `password`, `email`, `privateKey`, or `jwk` (at any nesting depth) are replaced with `[REDACTED]`.
- No user IP address, no email, and no default-PII enrichment is attached. No user identifier is associated with events.

End-user browser-side errors are also captured. When an unhandled error occurs in your browser, the following data is sent to Sentry:

- The error message and stack trace (the stack maps back to the TypeScript source).
- The URL path you were on at the time of the error.
- Your browser type and version (User-Agent string).
- The deploy version of the site (a git commit SHA).
- A record of the last ~50 client-side actions leading up to the error: navigations between pages, network requests made (URL only, with auth headers stripped before transmission), and console messages.

We do **not** send:

- Your IP address (IP storage is disabled).
- Your email address.
- Any auth tokens, cookies, or session identifiers.
- Any user identifier. Sentry cannot associate a browser error with a specific account.

## Per-user isolation

All content rows are scoped by user ID and protected by row-level security. Librito has no sharing features.
