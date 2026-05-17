-- 20260517000001_book_catalog_cover_max_width.sql
--
-- Adds `cover_max_width` — the decoded width (in pixels) of the source bytes
-- uploaded to cover storage. NULL for negative-cache rows (no cover stored).
--
-- Powers tiered variant fallback in `coverUrl()`: when a caller requests a
-- variant whose configured dimensions exceed the stored source width, we
-- substitute the largest variant that fits natively. Source quality is honest
-- and never silently upscaled by Cloudflare Images.

ALTER TABLE book_catalog
  ADD COLUMN cover_max_width INTEGER;

COMMENT ON COLUMN book_catalog.cover_max_width IS
  'Decoded source width in pixels for the stored cover (NULL for negative-cache rows). Drives variant-fallback in coverUrl() when requested variant exceeds source resolution. See docs/superpowers/plans/2026-05-17-catalog-cover-resolution.md.';

-- Re-declare both upsert RPCs to include cover_max_width in INSERT column
-- list, VALUES block, and ON CONFLICT SET clause. The function bodies are
-- otherwise identical to the prior declaration in
-- 20260502000001_rename_cover_cache_to_book_catalog.sql.

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
    CASE WHEN p_row ? 'subjects'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_row->'subjects'))
         ELSE NULL END,
    p_row->>'series_name',
    NULLIF(p_row->>'series_position', '')::numeric,
    p_row->>'isbn_10',
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
    title                  = COALESCE(EXCLUDED.title, book_catalog.title),
    author                 = COALESCE(EXCLUDED.author, book_catalog.author),
    description            = COALESCE(EXCLUDED.description, book_catalog.description),
    description_raw        = COALESCE(EXCLUDED.description_raw, book_catalog.description_raw),
    description_provider   = COALESCE(EXCLUDED.description_provider, book_catalog.description_provider),
    fetched_at             = COALESCE(EXCLUDED.fetched_at, book_catalog.fetched_at),
    last_attempted_at      = EXCLUDED.last_attempted_at,
    attempt_count          = EXCLUDED.attempt_count;
END $$;

-- Grants (preserve from prior migration — service_role only).
-- REVOKE FROM PUBLIC + per-role revokes needed because Supabase grants
-- EXECUTE on public-schema functions to anon/authenticated by default.
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) TO service_role;
