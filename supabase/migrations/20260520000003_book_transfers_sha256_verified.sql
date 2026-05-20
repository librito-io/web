-- Server-side sha256 verification for book_transfers.
-- Issue: #287
--
-- Background. /api/transfer/initiate accepts a client-supplied sha256 and
-- stores it on book_transfers.sha256; the same value is later returned to
-- the device firmware in the sync response, where the firmware rehashes
-- the downloaded file on disk and hard-rejects on mismatch
-- (TransferManager.cpp:342). Two failure modes:
--
--   1. Honest-browser bug. crypto.subtle.digest hashes one read of the
--      File; the upload reads it again. Memory pressure (Safari) or a
--      file modified between reads makes the uploaded bytes diverge from
--      the hashed bytes. The device sees mismatch and retries to the
--      attempt cap, then marks the row 'failed'. User has to re-upload.
--
--   2. Adversarial browser. A tampered client fabricates an arbitrary
--      sha256 and uploads anything. The device receives a
--      server-presented (but client-asserted) hash and treats it as a
--      server integrity guarantee.
--
-- Fix: server hashes the uploaded object after upload, before it is
-- visible to the device. The /api/transfer/[id]/finalize endpoint
-- streams the storage object, computes sha256, compares against the
-- client-claimed sha256, and writes the verified value on match (or
-- flips status to 'failed' on mismatch). The sync response then gates
-- on sha256_verified IS NOT NULL AND sha256_verified = sha256, so the
-- device never sees a row whose hash the server has not independently
-- confirmed.
--
-- Schema. Two nullable columns rather than a single sha256_verified_at
-- timestamp + reusing book_transfers.sha256, because:
--   - Keeping the two values separately lets a future audit / repair
--     job distinguish "client said X, server saw X" from a manual
--     backfill or a re-verify after corruption.
--   - The verified_pair CHECK below enforces that the columns travel
--     together at the schema level, removing a runtime invariant the
--     handler would otherwise have to guard.
--
-- Backfill. Intentionally none. Currently-pending rows ship with
-- sha256_verified = NULL and become invisible to the sync gate when the
-- application layer turns it on. Pre-launch sole-dev scale: the pending
-- queue is sub-10 rows; users re-uploading is a smaller cost than
-- carrying a backfill RPC that must replay the server-side hash
-- (which doesn't exist yet at migration-apply time). The Pass C sweep
-- in transfer-sweep cron handles new pendings that never reach
-- /finalize (browser closes between upload and finalize), so the
-- "stuck pending" failure mode is bounded.

-- 1. Verification columns.
ALTER TABLE public.book_transfers
  ADD COLUMN sha256_verified text,
  ADD COLUMN verified_at timestamptz;

-- 2. Format check: verified hash is either NULL or 64-hex (matches
-- the existing valid_sha256 CHECK on the client-claimed column).
ALTER TABLE public.book_transfers
  ADD CONSTRAINT valid_sha256_verified
    CHECK (
      sha256_verified IS NULL
      OR sha256_verified ~ '^[0-9a-f]{64}$'
    );

-- 3. Pair invariant: both columns travel together. Either both NULL
-- (unverified) or both NOT NULL (verified-at-timestamp). Removes the
-- runtime guard the handler would otherwise need on every UPDATE.
ALTER TABLE public.book_transfers
  ADD CONSTRAINT verified_pair
    CHECK (
      (sha256_verified IS NULL AND verified_at IS NULL)
      OR (sha256_verified IS NOT NULL AND verified_at IS NOT NULL)
    );

-- No new index. The sync hot path is already covered by
-- idx_transfers_user_status (user_id, status) from
-- 20260429000005; adding sha256_verified IS NOT NULL to the WHERE
-- clause is filtered in-memory off that partial scan. Pre-launch row
-- count makes this invisible; the 1k-user target stresses the
-- per-user pending queue, which is bounded by MAX_PENDING_TRANSFERS
-- (20). Revisit if EXPLAIN shows the filter dominating.
