-- GRANT for claim_pairing_atomic (see 20260430000001).
-- Split per-statement to dodge a Supabase CLI v2.90 multi-statement
-- parser bug; see footer of 20260430000001 for context.
--
-- The REVOKE-then-GRANT pattern is the repo standard for SECURITY INVOKER
-- functions: Postgres grants EXECUTE to PUBLIC by default, and Supabase's
-- anon and authenticated roles inherit from PUBLIC. RLS on pairing_codes
-- and devices currently has no policies (zero client access), which blocks
-- direct PostgREST /rpc/ calls today, but the explicit REVOKE documents
-- intent and survives any future RLS policy that grants SELECT/UPDATE.

REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text)
  TO service_role;
