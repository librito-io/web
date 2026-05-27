-- 20260527000006_book_catalog_upsert_with_state.sql
--
-- Extends upsert_book_catalog_by_isbn / _by_title_author to accept the 22
-- per-field state columns added in 20260527000001. The walker's per-field
-- finalize step (PR2) writes state via these RPCs (initial pending-row
-- write) AND via post-upsert plain UPDATEs (per-field finalize for fields
-- whose walker ran).
--
-- Both RPCs preserve COALESCE(EXCLUDED.<col>, book_catalog.<col>) semantics
-- across the new state columns so a leg that didn't run doesn't clobber an
-- earlier state. *_attempts uses GREATEST so the lifetime counter is
-- monotonic across concurrent resolves — see migration 20260527000004's
-- requeue_catalog_resolve comment for why attempts is a lifetime metric.
--
-- TA variant also extends its INSERT/UPDATE set with publisher /
-- published_date / page_count / subjects, which the walker now populates
-- on TA resolves (the GB legs work title+author keyed, same as description).
-- Pre-refit TA upserts intentionally omitted those four columns.

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
    pending_storage,
    fetched_at, last_attempted_at, attempt_count,
    -- 22 state columns from 20260527000001
    cover_attempted_at, cover_fail_reason, cover_attempts,
    description_attempted_at, description_fail_reason, description_attempts,
    publisher_attempted_at, publisher_fail_reason, publisher_attempts, publisher_provider,
    published_date_attempted_at, published_date_fail_reason, published_date_attempts, published_date_provider,
    subjects_attempted_at, subjects_fail_reason, subjects_attempts, subjects_provider,
    page_count_attempted_at, page_count_fail_reason, page_count_attempts, page_count_provider
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
    COALESCE((p_row->>'pending_storage')::BOOLEAN, FALSE),
    COALESCE((p_row->>'fetched_at')::timestamptz, now()),
    COALESCE((p_row->>'last_attempted_at')::timestamptz, now()),
    COALESCE(NULLIF(p_row->>'attempt_count','')::int, 0),
    -- state columns
    NULLIF(p_row->>'cover_attempted_at', '')::timestamptz,
    p_row->>'cover_fail_reason',
    COALESCE(NULLIF(p_row->>'cover_attempts','')::int, 0),
    NULLIF(p_row->>'description_attempted_at', '')::timestamptz,
    p_row->>'description_fail_reason',
    COALESCE(NULLIF(p_row->>'description_attempts','')::int, 0),
    NULLIF(p_row->>'publisher_attempted_at', '')::timestamptz,
    p_row->>'publisher_fail_reason',
    COALESCE(NULLIF(p_row->>'publisher_attempts','')::int, 0),
    p_row->>'publisher_provider',
    NULLIF(p_row->>'published_date_attempted_at', '')::timestamptz,
    p_row->>'published_date_fail_reason',
    COALESCE(NULLIF(p_row->>'published_date_attempts','')::int, 0),
    p_row->>'published_date_provider',
    NULLIF(p_row->>'subjects_attempted_at', '')::timestamptz,
    p_row->>'subjects_fail_reason',
    COALESCE(NULLIF(p_row->>'subjects_attempts','')::int, 0),
    p_row->>'subjects_provider',
    NULLIF(p_row->>'page_count_attempted_at', '')::timestamptz,
    p_row->>'page_count_fail_reason',
    COALESCE(NULLIF(p_row->>'page_count_attempts','')::int, 0),
    p_row->>'page_count_provider'
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
    pending_storage        = EXCLUDED.pending_storage,
    fetched_at             = COALESCE(EXCLUDED.fetched_at, book_catalog.fetched_at),
    last_attempted_at      = EXCLUDED.last_attempted_at,
    attempt_count          = EXCLUDED.attempt_count,
    cover_attempted_at          = COALESCE(EXCLUDED.cover_attempted_at, book_catalog.cover_attempted_at),
    cover_fail_reason           = COALESCE(EXCLUDED.cover_fail_reason, book_catalog.cover_fail_reason),
    cover_attempts              = GREATEST(EXCLUDED.cover_attempts, book_catalog.cover_attempts),
    description_attempted_at    = COALESCE(EXCLUDED.description_attempted_at, book_catalog.description_attempted_at),
    description_fail_reason     = COALESCE(EXCLUDED.description_fail_reason, book_catalog.description_fail_reason),
    description_attempts        = GREATEST(EXCLUDED.description_attempts, book_catalog.description_attempts),
    publisher_attempted_at      = COALESCE(EXCLUDED.publisher_attempted_at, book_catalog.publisher_attempted_at),
    publisher_fail_reason       = COALESCE(EXCLUDED.publisher_fail_reason, book_catalog.publisher_fail_reason),
    publisher_attempts          = GREATEST(EXCLUDED.publisher_attempts, book_catalog.publisher_attempts),
    publisher_provider          = COALESCE(EXCLUDED.publisher_provider, book_catalog.publisher_provider),
    published_date_attempted_at = COALESCE(EXCLUDED.published_date_attempted_at, book_catalog.published_date_attempted_at),
    published_date_fail_reason  = COALESCE(EXCLUDED.published_date_fail_reason, book_catalog.published_date_fail_reason),
    published_date_attempts     = GREATEST(EXCLUDED.published_date_attempts, book_catalog.published_date_attempts),
    published_date_provider     = COALESCE(EXCLUDED.published_date_provider, book_catalog.published_date_provider),
    subjects_attempted_at       = COALESCE(EXCLUDED.subjects_attempted_at, book_catalog.subjects_attempted_at),
    subjects_fail_reason        = COALESCE(EXCLUDED.subjects_fail_reason, book_catalog.subjects_fail_reason),
    subjects_attempts           = GREATEST(EXCLUDED.subjects_attempts, book_catalog.subjects_attempts),
    subjects_provider           = COALESCE(EXCLUDED.subjects_provider, book_catalog.subjects_provider),
    page_count_attempted_at     = COALESCE(EXCLUDED.page_count_attempted_at, book_catalog.page_count_attempted_at),
    page_count_fail_reason      = COALESCE(EXCLUDED.page_count_fail_reason, book_catalog.page_count_fail_reason),
    page_count_attempts         = GREATEST(EXCLUDED.page_count_attempts, book_catalog.page_count_attempts),
    page_count_provider         = COALESCE(EXCLUDED.page_count_provider, book_catalog.page_count_provider);
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
    pending_storage,
    title, author, description, description_raw, description_provider,
    fetched_at, last_attempted_at, attempt_count,
    -- expanded textual fields now populated on TA resolves via the walker
    published_date, publisher, page_count, subjects,
    -- 22 state columns
    cover_attempted_at, cover_fail_reason, cover_attempts,
    description_attempted_at, description_fail_reason, description_attempts,
    publisher_attempted_at, publisher_fail_reason, publisher_attempts, publisher_provider,
    published_date_attempted_at, published_date_fail_reason, published_date_attempts, published_date_provider,
    subjects_attempted_at, subjects_fail_reason, subjects_attempts, subjects_provider,
    page_count_attempted_at, page_count_fail_reason, page_count_attempts, page_count_provider
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
    COALESCE((p_row->>'pending_storage')::BOOLEAN, FALSE),
    p_row->>'title',
    p_row->>'author',
    p_row->>'description',
    p_row->>'description_raw',
    p_row->>'description_provider',
    COALESCE((p_row->>'fetched_at')::timestamptz, now()),
    COALESCE((p_row->>'last_attempted_at')::timestamptz, now()),
    COALESCE(NULLIF(p_row->>'attempt_count','')::int, 0),
    -- expanded textual fields
    p_row->>'published_date',
    p_row->>'publisher',
    NULLIF(p_row->>'page_count', '')::int,
    CASE WHEN jsonb_typeof(p_row->'subjects') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_row->'subjects'))
         ELSE NULL END,
    -- state columns
    NULLIF(p_row->>'cover_attempted_at', '')::timestamptz,
    p_row->>'cover_fail_reason',
    COALESCE(NULLIF(p_row->>'cover_attempts','')::int, 0),
    NULLIF(p_row->>'description_attempted_at', '')::timestamptz,
    p_row->>'description_fail_reason',
    COALESCE(NULLIF(p_row->>'description_attempts','')::int, 0),
    NULLIF(p_row->>'publisher_attempted_at', '')::timestamptz,
    p_row->>'publisher_fail_reason',
    COALESCE(NULLIF(p_row->>'publisher_attempts','')::int, 0),
    p_row->>'publisher_provider',
    NULLIF(p_row->>'published_date_attempted_at', '')::timestamptz,
    p_row->>'published_date_fail_reason',
    COALESCE(NULLIF(p_row->>'published_date_attempts','')::int, 0),
    p_row->>'published_date_provider',
    NULLIF(p_row->>'subjects_attempted_at', '')::timestamptz,
    p_row->>'subjects_fail_reason',
    COALESCE(NULLIF(p_row->>'subjects_attempts','')::int, 0),
    p_row->>'subjects_provider',
    NULLIF(p_row->>'page_count_attempted_at', '')::timestamptz,
    p_row->>'page_count_fail_reason',
    COALESCE(NULLIF(p_row->>'page_count_attempts','')::int, 0),
    p_row->>'page_count_provider'
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
    pending_storage        = EXCLUDED.pending_storage,
    title                  = COALESCE(EXCLUDED.title, book_catalog.title),
    author                 = COALESCE(EXCLUDED.author, book_catalog.author),
    description            = COALESCE(EXCLUDED.description, book_catalog.description),
    description_raw        = COALESCE(EXCLUDED.description_raw, book_catalog.description_raw),
    description_provider   = COALESCE(EXCLUDED.description_provider, book_catalog.description_provider),
    fetched_at             = COALESCE(EXCLUDED.fetched_at, book_catalog.fetched_at),
    last_attempted_at      = EXCLUDED.last_attempted_at,
    attempt_count          = EXCLUDED.attempt_count,
    published_date         = COALESCE(EXCLUDED.published_date, book_catalog.published_date),
    publisher              = COALESCE(EXCLUDED.publisher, book_catalog.publisher),
    page_count             = COALESCE(EXCLUDED.page_count, book_catalog.page_count),
    subjects               = COALESCE(EXCLUDED.subjects, book_catalog.subjects),
    cover_attempted_at          = COALESCE(EXCLUDED.cover_attempted_at, book_catalog.cover_attempted_at),
    cover_fail_reason           = COALESCE(EXCLUDED.cover_fail_reason, book_catalog.cover_fail_reason),
    cover_attempts              = GREATEST(EXCLUDED.cover_attempts, book_catalog.cover_attempts),
    description_attempted_at    = COALESCE(EXCLUDED.description_attempted_at, book_catalog.description_attempted_at),
    description_fail_reason     = COALESCE(EXCLUDED.description_fail_reason, book_catalog.description_fail_reason),
    description_attempts        = GREATEST(EXCLUDED.description_attempts, book_catalog.description_attempts),
    publisher_attempted_at      = COALESCE(EXCLUDED.publisher_attempted_at, book_catalog.publisher_attempted_at),
    publisher_fail_reason       = COALESCE(EXCLUDED.publisher_fail_reason, book_catalog.publisher_fail_reason),
    publisher_attempts          = GREATEST(EXCLUDED.publisher_attempts, book_catalog.publisher_attempts),
    publisher_provider          = COALESCE(EXCLUDED.publisher_provider, book_catalog.publisher_provider),
    published_date_attempted_at = COALESCE(EXCLUDED.published_date_attempted_at, book_catalog.published_date_attempted_at),
    published_date_fail_reason  = COALESCE(EXCLUDED.published_date_fail_reason, book_catalog.published_date_fail_reason),
    published_date_attempts     = GREATEST(EXCLUDED.published_date_attempts, book_catalog.published_date_attempts),
    published_date_provider     = COALESCE(EXCLUDED.published_date_provider, book_catalog.published_date_provider),
    subjects_attempted_at       = COALESCE(EXCLUDED.subjects_attempted_at, book_catalog.subjects_attempted_at),
    subjects_fail_reason        = COALESCE(EXCLUDED.subjects_fail_reason, book_catalog.subjects_fail_reason),
    subjects_attempts           = GREATEST(EXCLUDED.subjects_attempts, book_catalog.subjects_attempts),
    subjects_provider           = COALESCE(EXCLUDED.subjects_provider, book_catalog.subjects_provider),
    page_count_attempted_at     = COALESCE(EXCLUDED.page_count_attempted_at, book_catalog.page_count_attempted_at),
    page_count_fail_reason      = COALESCE(EXCLUDED.page_count_fail_reason, book_catalog.page_count_fail_reason),
    page_count_attempts         = GREATEST(EXCLUDED.page_count_attempts, book_catalog.page_count_attempts),
    page_count_provider         = COALESCE(EXCLUDED.page_count_provider, book_catalog.page_count_provider);
END $$;

REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) TO service_role;
