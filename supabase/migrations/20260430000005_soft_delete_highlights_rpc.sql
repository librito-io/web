-- ============================================================
-- soft_delete_highlights(p_user_id, p_now, p_rows)
-- ============================================================
-- Batches the per-row UPDATE loop in `processSync()` (see
-- src/lib/server/sync.ts) into one statement. The previous shape
-- fired N round-trip UPDATEs in a Promise.all, with N capped at
-- 500 deletes per book × 50 books = 25,000 statements per request
-- worst case. At the project's 1k concurrent user scaling target
-- (CLAUDE.md "Scaling Target") even modest per-sync N values
-- saturate the connection pool.
--
-- This function takes the delete-set as JSONB and runs ONE UPDATE
-- with a CTE-derived join. Mirrors the increment_transfer_attempt
-- and claim_pairing_atomic patterns elsewhere in the codebase.
--
-- p_rows shape:
--   [{ "book_id": "<uuid>",
--      "chapter":    <smallint>,
--      "start_word": <int>,
--      "end_word":   <int> }, … ]
--
-- Returns: number of rows soft-deleted (rows already in the
-- soft-deleted state are skipped via the `deleted_at IS NULL`
-- filter, matching the pre-RPC semantics).
--
-- Service-role only — the device API path uses service_role and
-- the device payload is the only legitimate caller. anon /
-- authenticated must not be able to bypass RLS via this function.

CREATE OR REPLACE FUNCTION public.soft_delete_highlights(
  p_user_id uuid,
  p_now     timestamptz,
  p_rows    jsonb
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH targets AS (
    SELECT
      (e->>'book_id')::uuid     AS book_id,
      (e->>'chapter')::smallint AS chapter_index,
      (e->>'start_word')::int   AS start_word,
      (e->>'end_word')::int     AS end_word
    FROM jsonb_array_elements(p_rows) AS e
  )
  UPDATE highlights h
     SET deleted_at = p_now
    FROM targets t
   WHERE h.user_id       = p_user_id
     AND h.book_id       = t.book_id
     AND h.chapter_index = t.chapter_index
     AND h.start_word    = t.start_word
     AND h.end_word      = t.end_word
     AND h.deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- REVOKE-then-GRANT pattern, repo standard (see header of
-- 20260430000002_grant_claim_pairing_atomic.sql for the full
-- rationale). CLI is pinned >= v2.95.4, so the v2.90 "atomic
-- substring" parser bug (supabase/cli#5064) does not apply, and
-- no DO-block wrapper is needed.
REVOKE ALL ON FUNCTION public.soft_delete_highlights(uuid, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_highlights(uuid, timestamptz, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.soft_delete_highlights(uuid, timestamptz, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_highlights(uuid, timestamptz, jsonb) TO service_role;

COMMENT ON FUNCTION public.soft_delete_highlights IS
  'Batched soft-delete of highlights from a sync payload. Takes user_id, '
  'a server-side now() timestamp, and a JSONB array of '
  '{book_id, chapter, start_word, end_word} targets. Returns the count of '
  'rows transitioned from live -> soft-deleted (already-deleted rows are '
  'skipped). Service-role only; called from src/lib/server/sync.ts. See '
  'docs/audits/2026-04-29-server-helpers.md issue P1.';
