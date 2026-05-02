-- Rename cover_cache to book_catalog and extend with shared per-ISBN
-- metadata (cover refs + textual fields). See spec
-- docs/superpowers/specs/2026-05-02-book-catalog-covers-and-metadata-design.md.

ALTER TABLE cover_cache RENAME TO book_catalog;

-- Drop the old UNIQUE-on-isbn constraint; replaced by partial unique indexes
-- below so we can also key fallback rows on (title, author).
ALTER TABLE book_catalog DROP CONSTRAINT IF EXISTS cover_cache_isbn_key;
DROP INDEX IF EXISTS cover_cache_isbn_key;

ALTER TABLE book_catalog ALTER COLUMN isbn DROP NOT NULL;
ALTER TABLE book_catalog ALTER COLUMN storage_path DROP NOT NULL;

ALTER TABLE book_catalog
  ADD COLUMN normalized_title_author      text,
  ADD COLUMN cover_storage_backend        text
    CHECK (cover_storage_backend IN ('cloudflare-images', 'supabase')),
  ADD COLUMN image_sha256                 text
    CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN cover_source                 text,
  ADD COLUMN openlibrary_cover_id         bigint,
  ADD COLUMN google_volume_id             text,
  ADD COLUMN last_attempted_at            timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attempt_count                int         NOT NULL DEFAULT 0,
  ADD COLUMN title                        text,
  ADD COLUMN author                       text,
  ADD COLUMN description                  text,
  ADD COLUMN description_raw              text,
  ADD COLUMN description_provider         text
    CHECK (description_provider IS NULL
           OR description_provider IN ('openlibrary', 'google_books', 'manual')),
  ADD COLUMN published_date               text,
  ADD COLUMN publisher                    text,
  ADD COLUMN page_count                   int CHECK (page_count IS NULL OR page_count > 0),
  ADD COLUMN language                     text,
  ADD COLUMN subjects                     text[],
  ADD COLUMN series_name                  text,
  ADD COLUMN series_position              numeric,
  ADD COLUMN isbn_10                      text,
  ADD COLUMN do_not_refetch_description   boolean NOT NULL DEFAULT false;

ALTER TABLE book_catalog
  ADD CONSTRAINT book_catalog_lookup_key
  CHECK (isbn IS NOT NULL OR normalized_title_author IS NOT NULL);

CREATE UNIQUE INDEX book_catalog_isbn_key
  ON book_catalog (isbn)
  WHERE isbn IS NOT NULL;

CREATE UNIQUE INDEX book_catalog_title_author_key
  ON book_catalog (normalized_title_author)
  WHERE isbn IS NULL AND normalized_title_author IS NOT NULL;

-- Negative-cache TTL sweep helper. Only rows with no successful upload
-- have storage_path = NULL; the partial index keeps it tiny.
CREATE INDEX book_catalog_negative_retry
  ON book_catalog (last_attempted_at)
  WHERE storage_path IS NULL;

-- Byte-level dedup lookup. Used at upload time to share storage
-- across ISBNs that resolve to the same cover image.
CREATE INDEX book_catalog_image_sha256
  ON book_catalog (image_sha256)
  WHERE image_sha256 IS NOT NULL;

-- Refresh comments for clarity.
COMMENT ON TABLE book_catalog IS
  'Shared per-ISBN book data — covers (storage backend ref) + textual '
  'metadata (title, author, blurb, publisher, page count, subjects, '
  'series). Deduplicated across users. Populated lazily via the '
  'catalog fetcher (Open Library + Google Books).';

COMMENT ON COLUMN book_catalog.isbn IS
  'Canonical ISBN-13 (digits only, validated checksum). NULL when the '
  'row is keyed on normalized_title_author for sideloaded EPUBs.';

COMMENT ON COLUMN book_catalog.normalized_title_author IS
  'lowercase(strip_punctuation(title)) || ''|'' || '
  'lowercase(strip_punctuation(author)). Set when isbn IS NULL.';

COMMENT ON COLUMN book_catalog.cover_storage_backend IS
  '''cloudflare-images'' (storage_path is the CF Images ID) or '
  '''supabase'' (storage_path is a path in the cover-cache Storage bucket). '
  'NULL when storage_path IS NULL (negative cache row).';

COMMENT ON COLUMN book_catalog.last_attempted_at IS
  'When the fetcher last attempted upstream resolution. Used together '
  'with storage_path IS NULL for negative-cache 30-day TTL.';

COMMENT ON COLUMN book_catalog.do_not_refetch_description IS
  'Set true after a publisher takedown request to prevent the Google '
  'Books fallback from re-populating description on subsequent fetches.';

COMMENT ON POLICY "Any authenticated user can read covers" ON book_catalog IS
  'Intentional — anon role cannot read book_catalog. Public embed/share '
  'pages must resolve URLs server-side and embed the resolved URL. The '
  'underlying cover-cache Storage bucket is world-readable; this table '
  'row (ISBN → storage_path + metadata) is treated as authenticated-only. '
  'See audit issue D3 (2026-04-29) and book-catalog spec (2026-05-02).';

-- ---------------------------------------------------------------------
-- Upsert RPCs.
--
-- Both unique indexes above are PARTIAL (`book_catalog_isbn_key` WHERE
-- isbn IS NOT NULL; `book_catalog_title_author_key` WHERE isbn IS NULL).
-- PostgreSQL ON CONFLICT requires the index predicate to be specified
-- alongside the conflict target — `INSERT ... ON CONFLICT (col) WHERE
-- pred DO UPDATE`. The supabase-js client's `.upsert(rows, { onConflict })`
-- helper does NOT thread the WHERE clause through, so calling it against a
-- partial unique index fails at runtime with "no unique or exclusion
-- constraint matching the ON CONFLICT specification". Wrap the upsert
-- in a SECURITY INVOKER RPC instead. The fetcher (service-role caller)
-- still has full table access; SECURITY INVOKER means RLS gates apply,
-- and `book_catalog` has no INSERT/UPDATE/DELETE policies so only
-- service-role bypasses can write. That preserves the existing security
-- posture (RLS-protected writes) without changing policy.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_book_catalog_by_isbn(p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO book_catalog (
    isbn, storage_path, cover_storage_backend, image_sha256, cover_source,
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
    image_sha256, cover_source, google_volume_id,
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

-- Service-role bypasses RLS so it can call these. Defense in depth:
-- explicitly revoke from PUBLIC and from anon/authenticated (Supabase
-- grants EXECUTE on public-schema functions to anon/authenticated by
-- default, and REVOKE FROM PUBLIC does NOT strip those per-role grants).
-- Without these explicit revokes, a future INSERT policy on book_catalog
-- for `authenticated` would silently turn these RPCs into a write surface
-- for any logged-in user. Only the fetcher (service-role) writes.
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_isbn(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_book_catalog_by_title_author(jsonb) TO service_role;
