-- Allow authenticated users to UPDATE their own devices row.
--
-- Background: the /app/devices route (rename + revoke actions) previously
-- used the admin client (service_role, bypassing RLS) because the devices
-- table only had a SELECT policy for authenticated users. That inverted
-- the architecture stated in CLAUDE.md: /app/* routes should use the
-- per-request anon client with RLS as the authoritative ownership gate.
-- This policy restores that invariant; the route can now use
-- event.locals.supabase for rename + revoke, with WITH CHECK enforcing
-- user_id ownership atomically inside Postgres rather than in a
-- pre-SELECT in TS (which created a TOCTOU defense-in-depth gap — see
-- closed issue #129).
--
-- No DELETE policy is added: revoke is implemented as a soft-delete via
-- the revoked_at column, which is an UPDATE.
--
-- (SELECT auth.uid()) wrapping matches the pattern from
-- 20260427000004 (caches the value for the lifetime of the query
-- instead of re-evaluating per row).

CREATE POLICY "Users can update own devices"
  ON public.devices
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
