-- 20260518000001_book_catalog_audit_columns.sql
--
-- Adds five nullable audit columns to `book_catalog` so post-deploy SQL
-- queries can validate the GoogleBooks `pdf.isAvailable` filter against
-- real production traffic without scraping logs. Columns:
--
--   gb_pdf_available       — accessInfo.pdf.isAvailable on the GB volume
--                            when we fetched one during this resolve.
--                            NULL when no GB volume was fetched.
--   gb_viewability         — accessInfo.viewability on the GB volume
--                            ('NO_PAGES' | 'PARTIAL' | 'ALL_PAGES' | etc).
--   gb_image_link_tiers    — keys present in volumeInfo.imageLinks at
--                            inspection time (e.g. ['extraLarge','large',
--                            'medium','small','smallThumbnail','thumbnail']).
--                            Lets a post-hoc query check whether full-tier
--                            volumes were rejected despite imageLinks
--                            presence (the n=9 sample showed this happens).
--   cover_aspect           — height / width of the accepted cover bytes.
--                            NULL for negative-cache rows.
--   cover_bytes_per_pixel  — byte_count / (width * height) of the accepted
--                            bytes. Interior pages compress hard (uniform
--                            whitespace) → low bpp; real covers have full-
--                            bleed art → higher bpp. Outlier detection seed.
--
-- All NULL-default. No backfill; pre-existing rows simply read NULL for
-- "audit info not captured." See:
--   docs/superpowers/plans/2026-05-18-catalog-cover-chain-hardening.md
--   issues #209 (revised mechanism), #211 (OL direct + precision-first)

ALTER TABLE book_catalog
  ADD COLUMN gb_pdf_available BOOLEAN,
  ADD COLUMN gb_viewability TEXT,
  ADD COLUMN gb_image_link_tiers TEXT[],
  ADD COLUMN cover_aspect NUMERIC(5,3),
  ADD COLUMN cover_bytes_per_pixel NUMERIC(7,5);

COMMENT ON COLUMN book_catalog.gb_pdf_available IS
  'GoogleBooks accessInfo.pdf.isAvailable at resolve time. NULL when no GB volume was fetched. Discriminates "real cover" (true) from "InDesign template / interior page artifact" (false) — see #209.';
COMMENT ON COLUMN book_catalog.gb_viewability IS
  'GoogleBooks accessInfo.viewability at resolve time. NULL when no GB volume fetched.';
COMMENT ON COLUMN book_catalog.gb_image_link_tiers IS
  'Keys present in GoogleBooks volumeInfo.imageLinks at resolve time. Lets post-hoc queries detect cases where tier presence does not predict bytes quality.';
COMMENT ON COLUMN book_catalog.cover_aspect IS
  'height / width of accepted cover bytes. NULL for negative-cache rows. Audit-only — no current rejection logic uses it.';
COMMENT ON COLUMN book_catalog.cover_bytes_per_pixel IS
  'byte_count / (width * height) of accepted cover bytes. Audit-only. Lower bpp = more aggressive compression (uniform regions like whitespace dominate interior pages).';

CREATE OR REPLACE FUNCTION public.upsert_book_catalog_by_isbn(p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO book_catalog (
    isbn, storage_path, cover_storage_backend, image_sha256, cover_source,
    cover_max_width,
    openlibrary_cover_id, google_volume_id, source_url,
    title, author, description, description_raw, description_provider,
    published_date, publisher, page_count, language, subjects,
    series_name, series_position, isbn_10,
    gb_pdf_available, gb_viewability, gb_image_link_tiers,
    cover_aspect, cover_bytes_per_pixel,
    fetched_at, last_attempted_at, attempt_count
  )
  VALUES (
    p_row->>'isbn',
    p_row->>'storage_path',
    p_row->>'cover_storage_backend',
    p_row->>'image_sha256',
    p_row->>'cover_source',
    NULLIF(p_row->>'cover_max_width', '')::integer,
    NULLIF(p_row->>'openlibrary_cover_id', '')::bigint,
    p_row->>'google_volume_id',
    p_row->>'source_url',
    p_row->>'title',
    p_row->>'author',
    p_row->>'description',
    p_row->>'description_raw',
    p_row->>'description_provider',
    p_row->>'published_date',
    p_row->>'publisher',
    NULLIF(p_row->>'page_count', '')::int,
    p_row->>'language',
    CASE WHEN jsonb_typeof(p_row->'subjects') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_row->'subjects'))
         ELSE NULL END,
    p_row->>'series_name',
    NULLIF(p_row->>'series_position', '')::numeric,
    p_row->>'isbn_10',
    (p_row->>'gb_pdf_available')::BOOLEAN,
    p_row->>'gb_viewability',
    CASE WHEN jsonb_typeof(p_row->'gb_image_link_tiers') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_row->'gb_image_link_tiers'))
         ELSE NULL END,
    (p_row->>'cover_aspect')::NUMERIC,
    (p_row->>'cover_bytes_per_pixel')::NUMERIC,
    COALESCE((p_row->>'fetched_at')::timestamptz, now()),
    COALESCE((p_row->>'last_attempted_at')::timestamptz, now()),
    COALESCE(NULLIF(p_row->>'attempt_count','')::int, 0)
  )
  ON CONFLICT (isbn) WHERE isbn IS NOT NULL
  DO UPDATE SET
    storage_path           = COALESCE(EXCLUDED.storage_path, book_catalog.storage_path),
    cover_storage_backend  = COALESCE(EXCLUDED.cover_storage_backend, book_catalog.cover_storage_backend),
    image_sha256           = COALESCE(EXCLUDED.image_sha256, book_catalog.image_sha256),
    cover_source           = COALESCE(EXCLUDED.cover_source, book_catalog.cover_source),
    cover_max_width        = COALESCE(EXCLUDED.cover_max_width, book_catalog.cover_max_width),
    openlibrary_cover_id   = COALESCE(EXCLUDED.openlibrary_cover_id, book_catalog.openlibrary_cover_id),
    google_volume_id       = COALESCE(EXCLUDED.google_volume_id, book_catalog.google_volume_id),
    source_url             = COALESCE(EXCLUDED.source_url, book_catalog.source_url),
    title                  = COALESCE(EXCLUDED.title, book_catalog.title),
    author                 = COALESCE(EXCLUDED.author, book_catalog.author),
    description            = COALESCE(EXCLUDED.description, book_catalog.description),
    description_raw        = COALESCE(EXCLUDED.description_raw, book_catalog.description_raw),
    description_provider   = COALESCE(EXCLUDED.description_provider, book_catalog.description_provider),
    published_date         = COALESCE(EXCLUDED.published_date, book_catalog.published_date),
    publisher              = COALESCE(EXCLUDED.publisher, book_catalog.publisher),
    page_count             = COALESCE(EXCLUDED.page_count, book_catalog.page_count),
    language               = COALESCE(EXCLUDED.language, book_catalog.language),
    subjects               = COALESCE(EXCLUDED.subjects, book_catalog.subjects),
    series_name            = COALESCE(EXCLUDED.series_name, book_catalog.series_name),
    series_position        = COALESCE(EXCLUDED.series_position, book_catalog.series_position),
    isbn_10                = COALESCE(EXCLUDED.isbn_10, book_catalog.isbn_10),
    gb_pdf_available       = COALESCE(EXCLUDED.gb_pdf_available, book_catalog.gb_pdf_available),
    gb_viewability         = COALESCE(EXCLUDED.gb_viewability, book_catalog.gb_viewability),
    gb_image_link_tiers    = COALESCE(EXCLUDED.gb_image_link_tiers, book_catalog.gb_image_link_tiers),
    cover_aspect           = COALESCE(EXCLUDED.cover_aspect, book_catalog.cover_aspect),
    cover_bytes_per_pixel  = COALESCE(EXCLUDED.cover_bytes_per_pixel, book_catalog.cover_bytes_per_pixel),
    fetched_at             = COALESCE(EXCLUDED.fetched_at, book_catalog.fetched_at),
    last_attempted_at      = EXCLUDED.last_attempted_at,
    attempt_count          = EXCLUDED.attempt_count;
END $$;

CREATE OR REPLACE FUNCTION public.upsert_book_catalog_by_title_author(p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO book_catalog (
    isbn, normalized_title_author, storage_path, cover_storage_backend,
    image_sha256, cover_source, cover_max_width, google_volume_id,
    gb_pdf_available, gb_viewability, gb_image_link_tiers,
    cover_aspect, cover_bytes_per_pixel,
    title, author, description, description_raw, description_provider,
    fetched_at, last_attempted_at, attempt_count
  )
  VALUES (
    NULL,
    p_row->>'normalized_title_author',
    p_row->>'storage_path',
    p_row->>'cover_storage_backend',
    p_row->>'image_sha256',
    p_row->>'cover_source',
    NULLIF(p_row->>'cover_max_width', '')::integer,
    p_row->>'google_volume_id',
    (p_row->>'gb_pdf_available')::BOOLEAN,
    p_row->>'gb_viewability',
    CASE WHEN jsonb_typeof(p_row->'gb_image_link_tiers') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_row->'gb_image_link_tiers'))
         ELSE NULL END,
    (p_row->>'cover_aspect')::NUMERIC,
    (p_row->>'cover_bytes_per_pixel')::NUMERIC,
    p_row->>'title',
    p_row->>'author',
    p_row->>'description',
    p_row->>'description_raw',
    p_row->>'description_provider',
    COALESCE((p_row->>'fetched_at')::timestamptz, now()),
    COALESCE((p_row->>'last_attempted_at')::timestamptz, now()),
    COALESCE(NULLIF(p_row->>'attempt_count','')::int, 0)
  )
  ON CONFLICT (normalized_title_author)
    WHERE isbn IS NULL AND normalized_title_author IS NOT NULL
  DO UPDATE SET
    storage_path           = COALESCE(EXCLUDED.storage_path, book_catalog.storage_path),
    cover_storage_backend  = COALESCE(EXCLUDED.cover_storage_backend, book_catalog.cover_storage_backend),
    image_sha256           = COALESCE(EXCLUDED.image_sha256, book_catalog.image_sha256),
    cover_source           = COALESCE(EXCLUDED.cover_source, book_catalog.cover_source),
    cover_max_width        = COALESCE(EXCLUDED.cover_max_width, book_catalog.cover_max_width),
    google_volume_id       = COALESCE(EXCLUDED.google_volume_id, book_catalog.google_volume_id),
    gb_pdf_available       = COALESCE(EXCLUDED.gb_pdf_available, book_catalog.gb_pdf_available),
    gb_viewability         = COALESCE(EXCLUDED.gb_viewability, book_catalog.gb_viewability),
    gb_image_link_tiers    = COALESCE(EXCLUDED.gb_image_link_tiers, book_catalog.gb_image_link_tiers),
    cover_aspect           = COALESCE(EXCLUDED.cover_aspect, book_catalog.cover_aspect),
    cover_bytes_per_pixel  = COALESCE(EXCLUDED.cover_bytes_per_pixel, book_catalog.cover_bytes_per_pixel),
    title                  = COALESCE(EXCLUDED.title, book_catalog.title),
    author                 = COALESCE(EXCLUDED.author, book_catalog.author),
    description            = COALESCE(EXCLUDED.description, book_catalog.description),
    description_raw        = COALESCE(EXCLUDED.description_raw, book_catalog.description_raw),
    description_provider   = COALESCE(EXCLUDED.description_provider, book_catalog.description_provider),
    fetched_at             = COALESCE(EXCLUDED.fetched_at, book_catalog.fetched_at),
    last_attempted_at      = EXCLUDED.last_attempted_at,
    attempt_count          = EXCLUDED.attempt_count;
END $$;

-- Grants unchanged from 20260502000001 / 20260517000001 / 20260517000002 —
-- service_role only. Re-declared because CREATE OR REPLACE FUNCTION does
-- not reset grants but a fresh re-grant on a re-declared body is harmless
-- and keeps the migration self-contained for `supabase db reset` audits.
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) TO service_role;
