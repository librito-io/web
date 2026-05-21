-- supabase/migrations/20260521000001_pg_cron_failure_summary.sql
--
-- SECURITY DEFINER function so service_role can read cron.job_run_details
-- without granting direct access to the cron schema. Returns failure
-- counts per job over the last 7 days. Queried by /api/cron/pg-cron-health
-- for Sentry alerting.
CREATE OR REPLACE FUNCTION public.pg_cron_failure_summary()
RETURNS TABLE (jobname text, failures bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT j.jobname, count(*) AS failures
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
   WHERE jrd.start_time > now() - interval '7 days'
     AND jrd.status != 'succeeded'
   GROUP BY j.jobname;
$$;

-- Two REVOKEs, both load-bearing:
--   FROM PUBLIC blocks the Postgres default where PUBLIC starts with
--     EXECUTE (covers schema redefinitions, future PG-version behavior).
--   FROM anon, authenticated blocks Supabase's ALTER DEFAULT PRIVILEGES
--     grant, which auto-grants EXECUTE on public-schema functions to
--     anon/authenticated/service_role for PostgREST. This grant is
--     SEPARATE from PUBLIC and survives REVOKE FROM PUBLIC alone.
-- Verified via supabase db reset --local + ACL inspection 2026-05-21:
-- without the second REVOKE, an anon session can call the function
-- and read cron.job_run_details indirectly (SECURITY DEFINER bypasses
-- the cron-schema grant gate). After both REVOKEs,
-- has_function_privilege('anon', 'public.pg_cron_failure_summary()',
-- 'EXECUTE') returns false.
REVOKE EXECUTE ON FUNCTION public.pg_cron_failure_summary() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pg_cron_failure_summary()
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pg_cron_failure_summary() TO service_role;

COMMENT ON FUNCTION public.pg_cron_failure_summary() IS
  'Returns pg_cron job failures in the last 7 days. Queried by /api/cron/pg-cron-health for Sentry alerting. SECURITY DEFINER (owned by postgres) so service_role can read cron schema indirectly.';
