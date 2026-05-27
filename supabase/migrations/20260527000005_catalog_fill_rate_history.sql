-- 20260527000005_catalog_fill_rate_history.sql
--
-- Weekly fill-rate observability for book_catalog. @sentry/sveltekit 10
-- removed Sentry.metrics.* in favor of spans/traces, so the spec's
-- table-fallback path applies: durable snapshot rows in Postgres, queried
-- by the admin sparkline (PR5). Cron handler at /api/cron/catalog-fill-rate
-- inserts one row per week via the compute_catalog_fill_rate() RPC below.
--
-- Admin-readable via RLS; service-role writes only. No retention policy
-- in this migration — weekly cadence + ~80 bytes/row keeps the table
-- comfortably small for years.

CREATE TABLE catalog_fill_rate_history (
  snapshot_at             timestamptz PRIMARY KEY DEFAULT now(),
  total_rows              int NOT NULL,
  missing_cover           int NOT NULL,
  missing_description     int NOT NULL,
  missing_publisher       int NOT NULL,
  missing_published_date  int NOT NULL,
  missing_subjects        int NOT NULL,
  missing_page_count      int NOT NULL,
  desc_from_openlibrary   int NOT NULL,
  desc_from_google_books  int NOT NULL,
  desc_from_itunes        int NOT NULL,
  desc_from_manual        int NOT NULL
);

ALTER TABLE catalog_fill_rate_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read fill-rate history" ON catalog_fill_rate_history
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin));

-- No INSERT/UPDATE/DELETE policies on authenticated; service-role only.

COMMENT ON TABLE catalog_fill_rate_history IS
  'Weekly snapshot of book_catalog fill rates. Written by the '
  '/api/cron/catalog-fill-rate cron. Admin sparkline reads from here.';

-- Aggregate RPC consumed by the catalog-fill-rate cron handler. Keeps the
-- handler trivial (one round-trip) and the SQL definition next to the
-- table that stores its output. service_role only — never exposed to
-- anon/authenticated via PostgREST.
CREATE FUNCTION public.compute_catalog_fill_rate()
RETURNS TABLE (
  total_rows              int,
  missing_cover           int,
  missing_description     int,
  missing_publisher       int,
  missing_published_date  int,
  missing_subjects        int,
  missing_page_count      int,
  desc_from_openlibrary   int,
  desc_from_google_books  int,
  desc_from_itunes        int,
  desc_from_manual        int
) LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public AS $$
  SELECT
    COUNT(*)::int                                                       AS total_rows,
    COUNT(*) FILTER (WHERE storage_path     IS NULL)::int               AS missing_cover,
    COUNT(*) FILTER (WHERE description      IS NULL)::int               AS missing_description,
    COUNT(*) FILTER (WHERE publisher        IS NULL)::int               AS missing_publisher,
    COUNT(*) FILTER (WHERE published_date   IS NULL)::int               AS missing_published_date,
    COUNT(*) FILTER (WHERE subjects         IS NULL)::int               AS missing_subjects,
    COUNT(*) FILTER (WHERE page_count       IS NULL)::int               AS missing_page_count,
    COUNT(*) FILTER (WHERE description_provider = 'openlibrary')::int   AS desc_from_openlibrary,
    COUNT(*) FILTER (WHERE description_provider = 'google_books')::int  AS desc_from_google_books,
    COUNT(*) FILTER (WHERE description_provider = 'itunes')::int        AS desc_from_itunes,
    COUNT(*) FILTER (WHERE description_provider = 'manual')::int        AS desc_from_manual
  FROM book_catalog;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_catalog_fill_rate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.compute_catalog_fill_rate() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.compute_catalog_fill_rate() TO service_role;
