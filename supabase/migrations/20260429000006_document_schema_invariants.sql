-- Document schema invariants on devices, book_transfers, and highlights
-- indexes (audit PR 7: D1, D4 Option B, D5, P7 — all comment-only).
--
-- Background: /repo-review on 2026-04-29 surfaced four documentation
-- drift / clarity items where schema comments either lie about behaviour,
-- under-specify intent, or fail to warn against a plausible "cleanup" by
-- a future contributor. None changes runtime behaviour; all five
-- statements below replace or attach a `COMMENT ON ...` so the rationale
-- travels with the schema instead of living only in this audit doc.
--
-- Postgres allows multiple `COMMENT ON ...` statements on the same
-- object; the latest wins. Earlier comments shipped on these objects
-- (devices.api_token_hash, book_transfers TABLE) are superseded by the
-- text below.

-- D1: devices.api_token_hash — earlier comments claimed "argon2id /
-- bcrypt" (20260412000002) and later "SHA-256 hex digest …
-- Indexed for fast lookup" (20260414000001). Both are correct or
-- terse; neither explains *why* a plain hash (no KDF) is the right
-- choice. OSS reviewers reading the schema will treat "SHA-256 of an
-- API token" as a security smell unless the high-entropy-input
-- rationale is stated inline.
COMMENT ON COLUMN public.devices.api_token_hash IS
  'SHA-256 hex of device API token (sk_device_xxx). The token is generated '
  'with full crypto entropy server-side (src/lib/server/tokens.ts) and shown '
  'to the user once at claim time, then discarded — no KDF needed because '
  'the input is already crypto-random. Matches the lookup performed by '
  'src/lib/server/auth.ts.';

-- D4 (Option B): book_transfers.uploaded_at — column name lies about
-- semantics. DEFAULT now() fires on row insert (initiate), so cron's
-- 48h expiry clock counts from initiate, not from upload completion.
-- Option A (rename to initiated_at) is deferred — too much TS surface
-- area for a docs-only PR. See audit D4 for that path.
COMMENT ON COLUMN public.book_transfers.uploaded_at IS
  'Timestamp when /api/transfer/initiate created the row. NOT the upload '
  'completion time — the file upload happens after row insert. Used as '
  'the expiry clock by expire-stale-transfers (48 h from initiate).';

-- D5: book_transfers UPDATE / DELETE RLS invariant. PR 2 (#28) already
-- shipped a TABLE comment covering INSERT/UPDATE/DELETE absence; this
-- replaces it with text that names the contributor failure mode
-- explicitly ("Cancel transfer", "Retry") so a search for those
-- features hits the warning. Tightened from the audit body to drop the
-- stale "(currently) INSERT … but see PR 2 — may be dropped" hedge —
-- PR 2 is merged and the INSERT policy is gone; the comment now
-- reflects post-#28 reality.
COMMENT ON TABLE public.book_transfers IS
  'Queue for EPUB transfers from web to device — storage is temporary. '
  'RLS allows authenticated browsers to SELECT only (status UI). INSERT, '
  'UPDATE, and DELETE are deliberately not granted to authenticated; all '
  'mutations (initiate, status changes, cancel, retry) MUST go through '
  'API routes using service_role. Adding a browser-side write via the '
  'Supabase JS client (e.g. a "Cancel transfer" or "Retry" button) will '
  'silently no-op — PostgREST does not error on RLS rejection. Revisit '
  'the quota / rate-limit / status-machine invariants enforced by '
  '/api/transfer/* before granting any browser-side write policy.';

-- P7: highlights has two indexes on (user_id, updated_at) that look
-- duplicative but serve different queries. They cannot be consolidated
-- — sync needs tombstones, feed must exclude them. Document each
-- index's owner so a future contributor doesn't drop the "redundant"
-- one. Double-write cost on INSERT/UPDATE is real but small at the 1k-
-- user scaling target.
COMMENT ON INDEX idx_highlights_sync IS
  'Sync hot path: WHERE updated_at > :lastSync includes tombstones (deleted_at IS NOT NULL). DO NOT add a partial filter — sync needs all rows.';

COMMENT ON INDEX highlights_user_updated_idx IS
  'Feed hot path: live rows only, DESC for chronological feed pagination. The partial WHERE deleted_at IS NULL is intentional — feed never shows tombstones.';
