# Privacy

_Last updated: 2026-04-23_

Librito stores the minimum data required to synchronise your highlights, notes, and books between your device and the web. This document describes exactly what we store, for how long, and who can reach it. These commitments are enforced by code — the scheduled jobs and API-level constraints are part of the repository, not policy claims.

## What we store

- **Account profile.** Email address + Supabase Auth identifiers. Used for login.
- **Book metadata.** Title, author, ISBN, language, and a device-generated 8-hex book hash. No reading progress. No extracted text from your books.
- **Highlights and notes.** The text you highlighted, your optional note, and the chapter / word position. Scoped to your account.
- **Device state.** Device-token hash, last-sync timestamps, device name.

## What we do not store

- **Book contents.** We do not store the body of your books after they have been delivered to your device. See the Transfer section below for the short delivery window.
- **Reading progress.** No per-book progress, no session telemetry.
- **Analytics or third-party tracking.**

## Book transfer retention

When you upload a book through the web app, Librito keeps a copy in temporary Storage just long enough to deliver it to your device.

- **Pending window: 48 hours.** If no paired device picks the upload up within 48 h, the row is auto-expired on the next hourly cleanup.
- **Delivered rows: scrubbed 24 h after delivery.** Filename, file hash, and Storage path are set to `NULL` on an hourly schedule — after this, we can no longer identify which book it was.
- **Expired rows: scrubbed 1 h after the 48 h TTL boundary.**
- **Storage objects: deleted within ~72 hours** in the worst case (48 h TTL + up to 24 h between daily Storage sweeps).
- **Hard deletion: 24 h after scrub**, the row itself is removed from the database.

## Server access to book files

Server code never reads the bytes of an uploaded book. All transit uses signed URLs: the browser uploads directly to Storage, and your device downloads directly from Storage. The server only mediates bookkeeping rows.

## Per-user isolation

All content rows are scoped by user ID and protected by row-level security. Librito has no sharing features.

## Pauses during inactivity

Librito's Storage is hosted on Supabase. On our free tier, the database pauses after a period of inactivity. While paused, scheduled cleanup jobs also pause — they catch up when activity resumes. This does not change the retention targets above once the database is active.

## Versioning

This document lives in the `librito-io/web` git repository. Any change to our privacy commitments goes through a pull request.
