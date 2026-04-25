-- WS-D follow-up: harden increment_transfer_attempt
--   * Pin search_path so future SECURITY DEFINER toggle (or unrelated
--     extension changes) cannot redirect catalog lookups.
--   * Revoke EXECUTE from PUBLIC. PostgREST exposes RPCs at /rest/v1/rpc/...
--     and `book_transfers` SELECT is permitted for authenticated users; the
--     UPDATE inside is currently blocked by RLS-without-policy, but that is
--     an implicit invariant. Restrict to service_role explicitly.
--   * Parameterize the attempt cap so the threshold lives in TS
--     (MAX_TRANSFER_ATTEMPTS in src/lib/server/transfer.ts) and SQL stays a
--     mechanical body. Default keeps existing call sites working.

DROP FUNCTION IF EXISTS public.increment_transfer_attempt(uuid);

CREATE OR REPLACE FUNCTION public.increment_transfer_attempt(
  p_transfer_id uuid,
  p_max_attempts int DEFAULT 10
)
RETURNS TABLE(attempt_count int, status text)
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  UPDATE public.book_transfers
  SET attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      status = CASE
                 WHEN attempt_count + 1 >= p_max_attempts THEN 'failed'
                 ELSE status
               END,
      last_error = CASE
                     WHEN attempt_count + 1 >= p_max_attempts
                     THEN 'Couldn''t deliver to your device after '
                          || p_max_attempts || ' attempts.'
                     ELSE last_error
                   END
  WHERE id = p_transfer_id AND status = 'pending'
  RETURNING attempt_count, status;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_transfer_attempt(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_transfer_attempt(uuid, int) TO service_role;
