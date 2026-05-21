-- supabase/migrations/20260521000004_ensure_realtime_helper.sql
--
-- Issue #114: extract the duplicated `pg_publication_tables` idempotency
-- guard used by 20260426000001 (notes) and 20260426000003 (book_transfers)
-- into a single helper so every future Realtime publication add is one line
-- of SQL instead of a copy-pasted DO block.
--
-- Existing migrations are deliberately NOT refactored — migration history
-- is immutable. The helper is for the next caller onward.
--
-- Helper contract:
--   SELECT public.ensure_realtime('public.<table>');
--
-- Resolves the schema and table name from the regclass via pg_class /
-- pg_namespace rather than `split_part(p_table::text, '.', 1)`: regclass
-- text rendering is search_path-dependent (bare name when the schema is
-- on the search_path, qualified otherwise), so split_part is a footgun
-- the moment a caller passes an unqualified or cross-schema regclass.
-- The catalog lookup is unambiguous and the EXECUTE uses %I quoting so
-- exotic table names (mixed case, reserved words) cannot break the DDL.
--
-- search_path = pg_catalog, public hardens the function against
-- search_path injection (cf. 20260429000003_harden_handle_new_user_search_path).
-- Not SECURITY DEFINER: ALTER PUBLICATION requires superuser / publication
-- owner privileges, which the postgres migration role already has;
-- service_role calling at runtime would fail at the ALTER step regardless,
-- so SECURITY DEFINER would buy nothing and add an audit surface.

CREATE OR REPLACE FUNCTION public.ensure_realtime(p_table regclass)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_schema text;
  v_table  text;
BEGIN
  SELECT n.nspname, c.relname
    INTO v_schema, v_table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_table;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = v_schema
       AND tablename  = v_table
  ) THEN
    EXECUTE format(
      'ALTER PUBLICATION supabase_realtime ADD TABLE %I.%I',
      v_schema, v_table
    );
  END IF;
END;
$$;

-- Two REVOKEs per the project pattern documented in CLAUDE.md
-- "Function EXECUTE grants" and exemplified in
-- 20260521000001_pg_cron_failure_summary.sql:
--   FROM PUBLIC strips the Postgres-level default grant.
--   FROM anon, authenticated strips the Supabase ALTER DEFAULT PRIVILEGES
--   grant that auto-exposes public-schema functions via PostgREST.
-- This function has no legitimate PostgREST caller — it is a migration-time
-- helper, full stop.
REVOKE EXECUTE ON FUNCTION public.ensure_realtime(regclass) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ensure_realtime(regclass)
  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ensure_realtime(regclass) TO service_role;

COMMENT ON FUNCTION public.ensure_realtime(regclass) IS
  'Idempotently add a table to the supabase_realtime publication. Use from migrations as `SELECT public.ensure_realtime(''public.<table>'');`. Wraps the pg_publication_tables membership guard previously duplicated across realtime migrations (issue #114).';

-- First use of the helper: re-assert membership for the two tables already
-- in the publication. Both calls are no-ops (idempotent guard) but exercise
-- the function end-to-end at migration time, so a regression in the helper
-- surfaces as a deploy failure rather than at the next Realtime add.
SELECT public.ensure_realtime('public.notes');
SELECT public.ensure_realtime('public.book_transfers');
