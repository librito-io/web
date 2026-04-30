-- GRANT for claim_pairing_atomic (see 20260430000001).
--
-- The REVOKE-then-GRANT pattern is the repo standard for SECURITY INVOKER
-- functions: Postgres grants EXECUTE to PUBLIC by default, and Supabase's
-- anon and authenticated roles inherit from PUBLIC. RLS on pairing_codes
-- and devices currently has no policies for these roles (zero client
-- access), which blocks direct PostgREST /rpc/ calls today, but the
-- explicit REVOKE documents intent and survives any future RLS policy
-- that grants SELECT/UPDATE.
--
-- WHY THE DO BLOCK: this file originally contained four bare statements
-- (3 REVOKE + 1 GRANT). The Supabase CLI v2.90 prepared-statement parser
-- sometimes sends multi-statement files as a single Parse message, hitting
-- Postgres SQLSTATE 42601 ("cannot insert multiple commands into a
-- prepared statement"). The trigger is inconsistent — it caught us during
-- production `supabase db push` even though local `db reset` had passed
-- with the earlier single-GRANT shape. Wrapping in a DO block collapses
-- the file to a single statement from the parser's perspective. Direct
-- psql ingestion of the bare-statement form works fine; this is purely
-- a CLI workaround.

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM anon;
  REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) TO service_role;
END;
$$;
