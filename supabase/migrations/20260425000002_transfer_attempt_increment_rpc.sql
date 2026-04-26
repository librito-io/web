-- WS-D: atomic increment of book_transfers.attempt_count with cap-hit
-- branching. Called by /api/transfer/[id]/confirm failure path.
-- Spec: docs/superpowers/specs/2026-04-25-ws-d-transfer-retry-ui.md §8.2.

CREATE OR REPLACE FUNCTION public.increment_transfer_attempt(p_transfer_id uuid)
RETURNS TABLE(attempt_count int, status text)
LANGUAGE sql AS $$
  UPDATE public.book_transfers
  SET attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      status = CASE WHEN attempt_count + 1 >= 10 THEN 'failed' ELSE status END,
      last_error = CASE WHEN attempt_count + 1 >= 10
                        THEN 'Couldn''t deliver to your device after 10 attempts.'
                        ELSE last_error END
  WHERE id = p_transfer_id AND status = 'pending'
  RETURNING attempt_count, status;
$$;
