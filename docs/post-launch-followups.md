# Post-launch follow-ups

Items to revisit once the project has real production traffic. Pre-launch latitude (sole dev, no users) lets us defer these without risk. Re-evaluate when the data is meaningful.

## Unused index advisor — re-evaluate 60+ days after launch

**Logged:** 2026-04-27

Supabase performance advisor flagged 7 indexes as unused (zero usage in the stats window):

- `public.devices.idx_devices_token` — device-auth hot path (`/api/sync`, `/api/realtime-token`, `/api/transfer/*`)
- `public.highlights.idx_highlights_sync (user_id, updated_at)` — sync hot path
- `public.highlights.idx_highlights_book (book_id, chapter_index)` — highlight viewer ordering
- `public.book_transfers.idx_transfers_device (device_id, status)` — device polling for transfers
- `public.notes.idx_notes_sync (user_id, updated_at)` — notes sync hot path
- `public.pairing_codes.idx_pairing_expires` — cron cleanup of expired codes
- `public.pairing_codes.idx_pairing_hardware (hardware_id) WHERE claimed = false` — pairing-status polling

All 7 are intentional, documented in migration comments, and designed for hot paths that will fire under production load. Pre-launch snapshot shows zero usage because there is no real traffic yet — not because the indexes are dead.

**Action:** wait until 60+ days after public launch with active users. Re-run the Supabase advisor against the new stats window. If any of the 7 still show zero usage with real traffic exercising the documented query patterns, that's evidence the index is dead and can be dropped via a DROP INDEX migration. Until then, leave them alone.

**Do not act on this warning pre-launch.** Removing now and re-adding later means seq scans on production hot paths (`/api/sync`, `/api/realtime-token`) the moment users arrive, plus the operational fragility of `CREATE INDEX CONCURRENTLY` on a populated table.

## Leaked password protection (Pro-plan gated)

**Logged:** 2026-04-27

Supabase Auth's HaveIBeenPwned check is locked behind the Pro plan. Currently disabled on free tier. Per CLAUDE.md scaling target ("paid tiers expected and budgeted at roughly 200+ users"), we'll upgrade to Pro at that threshold.

**Action on Pro upgrade:** Authentication → Policies → Password Settings → toggle "Prevent use of leaked passwords" ON.
