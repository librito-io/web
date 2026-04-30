-- GRANT for claim_pairing_atomic (see 20260430000001).
-- Split per-statement to dodge a Supabase CLI v2.90 multi-statement
-- parser bug; see footer of 20260430000001 for context.

GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text)
  TO service_role;
