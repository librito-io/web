-- Defense-in-depth: explicitly REVOKE EXECUTE from anon/authenticated on
-- public-schema functions where those grants serve no legitimate caller.
-- Closes issue #327.
--
-- Background:
--
--   Supabase bootstraps every Postgres project with ALTER DEFAULT
--   PRIVILEGES that auto-grants EXECUTE on every newly-created public
--   function to anon, authenticated, and service_role. This is the
--   default that PostgREST relies on to expose /rest/v1/rpc/<name>.
--
--   REVOKE EXECUTE ... FROM PUBLIC is a Postgres-level revoke; it does
--   NOT touch the per-role grants applied by Supabase's default. A
--   function with only `REVOKE FROM PUBLIC + GRANT TO service_role`
--   still has anon/authenticated EXECUTE via the default-privileges
--   grant. Discovered during the PR #326 (pg_cron_failure_summary)
--   work — there the SECURITY DEFINER posture made the gap exploitable;
--   the fix established the explicit two-REVOKE template that
--   20260521000001 follows.
--
--   This migration applies the same template to every other
--   public-schema function in the database where anon/authenticated
--   EXECUTE serves no legitimate caller, after a per-function audit:
--
--   1. public.increment_transfer_attempt(uuid, int)
--      Issue #327's named target. Backend-only RPC invoked by
--      /api/transfer/* via service_role. NOT SECURITY DEFINER so the
--      inner UPDATE on book_transfers is gated by RLS today — not a
--      privilege escalation at the moment. A future RLS refactor that
--      loosens UPDATE on book_transfers would turn this into a real
--      anon-callable mutation surface; this revoke is the layer that
--      catches that regression before it ships.
--
--   2. public.devices_prevent_unrevoke()
--      Trigger function. PostgreSQL does NOT check EXECUTE permission
--      when a function is invoked via trigger (same exemption as
--      handle_new_user, 20260427000003), so the BEFORE UPDATE trigger
--      on public.devices continues to fire normally for all roles
--      including service_role. The function has no PostgREST caller —
--      its presence at /rest/v1/rpc/devices_prevent_unrevoke is purely
--      incidental to it living in the public schema.
--
--   3. public.update_updated_at()
--      Same posture as devices_prevent_unrevoke. BEFORE UPDATE trigger
--      on highlights/notes/books; no legitimate PostgREST caller.
--
--   4. public.get_highlight_feed(text, jsonb, int, text)
--   5. public.get_library_with_highlights()
--      These ARE intentional PostgREST RPCs for the /app/feed and
--      /app/library views. SECURITY INVOKER; require a real auth.uid()
--      and short-circuit to empty when v_uid IS NULL. anon EXECUTE is
--      not load-bearing — anon hits today return [] or empty rowset.
--      Revoking anon EXECUTE makes PostgREST deny at the boundary
--      instead of returning the empty result, which is the correct
--      semantics anyway. authenticated EXECUTE is preserved.
--
-- Verification: tests/integration/public-function-grants.test.ts asserts
-- has_function_privilege() returns false for anon (and authenticated
-- where applicable) post-migration. The supabase-js anon .rpc() boundary
-- check is omitted for the trigger functions (calling them as anon
-- against the local Postgres 17.6 Docker image segfaults the test DB
-- mid-suite — same exemption documented in pg-cron-health.test.ts).

-- ---------------------------------------------------------------------
-- 1. increment_transfer_attempt(uuid, int) — service_role only
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.increment_transfer_attempt(uuid, int)
  FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. devices_prevent_unrevoke() — trigger-only
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.devices_prevent_unrevoke()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.devices_prevent_unrevoke()
  FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. update_updated_at() — trigger-only
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.update_updated_at()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_updated_at()
  FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. get_highlight_feed(text, jsonb, int, text) — authenticated only
-- ---------------------------------------------------------------------
-- Both REVOKEs are load-bearing here. The original 20260429000004 and
-- 20260503000002 migrations only added GRANT TO authenticated; they did
-- not REVOKE FROM PUBLIC. anon therefore retains EXECUTE via the
-- Postgres default PUBLIC grant (=X/postgres in proacl), independently
-- of the Supabase ALTER DEFAULT PRIVILEGES per-role grant. Both layers
-- must be revoked. authenticated's explicit grant survives REVOKE FROM
-- PUBLIC unchanged.
REVOKE EXECUTE ON FUNCTION public.get_highlight_feed(text, jsonb, int, text)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_highlight_feed(text, jsonb, int, text)
  FROM anon;

-- ---------------------------------------------------------------------
-- 5. get_library_with_highlights() — authenticated only
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.get_library_with_highlights()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_library_with_highlights()
  FROM anon;
