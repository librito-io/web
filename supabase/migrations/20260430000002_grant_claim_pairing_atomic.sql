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
-- HISTORICAL NOTE — DO BLOCK WORKAROUND, NOW REMOVED:
-- This file's original PR (#41) wrapped the four access-control statements
-- in a DO $$ ... $$; block to dodge a Supabase CLI v2.90 parser bug. The
-- bug, fixed in CLI v2.91.1 (supabase/cli#5064 "atomic parser"), was that
-- the SQL splitter treated the substring "atomic" inside any identifier
-- (e.g. our `claim_pairing_atomic` function name) as the start of a
-- `BEGIN ATOMIC ... END;` block, then bundled subsequent statements into
-- one prepared-statement Parse message and tripped Postgres SQLSTATE 42601
-- ("cannot insert multiple commands into a prepared statement"). The
-- "inconsistent trigger" the audit described was actually deterministic
-- and keyed on the substring "atomic" in the function name — not flaky
-- parsing. CI is now pinned to v2.95.4 (>= 2.91.1) so the wrapper is dead
-- weight; bare REVOKE+GRANT applies cleanly via local `db reset` and prod
-- `db push`. CLI downgrades below 2.91.1 will re-break this file — pin
-- bump in `.github/workflows/migration-smoke.yml` is load-bearing.

REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pairing_atomic(uuid, uuid, text) TO service_role;
