-- 20260527000001_book_catalog_field_state.sql
--
-- Adds per-field resolve state to book_catalog: <field>_attempted_at,
-- <field>_attempts, <field>_fail_reason, <field>_provider for the six
-- tracked fields (cover, description, publisher, published_date,
-- subjects, page_count). Cover keeps storage_path as its value-presence
-- discriminant; other fields' value columns already exist. Defensive
-- CHECK on cover_source extends the existing literal set with 'manual'.
-- Spec: docs/superpowers/specs/2026-05-27-catalog-architecture-refit-design.md.

ALTER TABLE book_catalog
  ADD COLUMN cover_attempted_at          timestamptz,
  ADD COLUMN cover_attempts              int NOT NULL DEFAULT 0,
  ADD COLUMN cover_fail_reason           text,
  ADD COLUMN description_attempted_at    timestamptz,
  ADD COLUMN description_attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN description_fail_reason     text,
  ADD COLUMN publisher_attempted_at      timestamptz,
  ADD COLUMN publisher_attempts          int NOT NULL DEFAULT 0,
  ADD COLUMN publisher_fail_reason       text,
  ADD COLUMN publisher_provider          text,
  ADD COLUMN published_date_attempted_at timestamptz,
  ADD COLUMN published_date_attempts     int NOT NULL DEFAULT 0,
  ADD COLUMN published_date_fail_reason  text,
  ADD COLUMN published_date_provider     text,
  ADD COLUMN subjects_attempted_at       timestamptz,
  ADD COLUMN subjects_attempts           int NOT NULL DEFAULT 0,
  ADD COLUMN subjects_fail_reason        text,
  ADD COLUMN subjects_provider           text,
  ADD COLUMN page_count_attempted_at     timestamptz,
  ADD COLUMN page_count_attempts         int NOT NULL DEFAULT 0,
  ADD COLUMN page_count_fail_reason      text,
  ADD COLUMN page_count_provider         text;

-- fail_reason CHECK per field. Six legal buckets drive the TTL ladder in
-- _field_replay_due (20260527000004): rate_limited / transient_error retry
-- in 1h, provider_disabled in 24h, provider_empty_field in 30d, provider_no_data
-- + exhausted in 90d.
ALTER TABLE book_catalog
  ADD CONSTRAINT book_catalog_cover_fail_reason_chk
    CHECK (cover_fail_reason IS NULL OR cover_fail_reason IN
      ('rate_limited','transient_error','provider_disabled',
       'provider_empty_field','provider_no_data','exhausted')),
  ADD CONSTRAINT book_catalog_description_fail_reason_chk
    CHECK (description_fail_reason IS NULL OR description_fail_reason IN
      ('rate_limited','transient_error','provider_disabled',
       'provider_empty_field','provider_no_data','exhausted')),
  ADD CONSTRAINT book_catalog_publisher_fail_reason_chk
    CHECK (publisher_fail_reason IS NULL OR publisher_fail_reason IN
      ('rate_limited','transient_error','provider_disabled',
       'provider_empty_field','provider_no_data','exhausted')),
  ADD CONSTRAINT book_catalog_published_date_fail_reason_chk
    CHECK (published_date_fail_reason IS NULL OR published_date_fail_reason IN
      ('rate_limited','transient_error','provider_disabled',
       'provider_empty_field','provider_no_data','exhausted')),
  ADD CONSTRAINT book_catalog_subjects_fail_reason_chk
    CHECK (subjects_fail_reason IS NULL OR subjects_fail_reason IN
      ('rate_limited','transient_error','provider_disabled',
       'provider_empty_field','provider_no_data','exhausted')),
  ADD CONSTRAINT book_catalog_page_count_fail_reason_chk
    CHECK (page_count_fail_reason IS NULL OR page_count_fail_reason IN
      ('rate_limited','transient_error','provider_disabled',
       'provider_empty_field','provider_no_data','exhausted'));

-- cover_source defensive CHECK. Column existed un-constrained pre-refit; the
-- post-truncate / pre-launch posture allows tightening without a backfill
-- step. 'manual' added for admin uploads (PR5).
ALTER TABLE book_catalog
  ADD CONSTRAINT book_catalog_cover_source_chk
    CHECK (cover_source IS NULL OR cover_source IN
      ('openlibrary_isbn_direct','openlibrary_isbn','openlibrary_search_title',
       'google_books','itunes','manual'));

-- Provider CHECK on the four text-field providers (publisher, published_date,
-- subjects, page_count). cover uses cover_source; description uses
-- description_provider (existing constraint extended below).
ALTER TABLE book_catalog
  ADD CONSTRAINT book_catalog_publisher_provider_chk
    CHECK (publisher_provider IS NULL OR publisher_provider IN
      ('openlibrary','google_books','itunes','manual')),
  ADD CONSTRAINT book_catalog_published_date_provider_chk
    CHECK (published_date_provider IS NULL OR published_date_provider IN
      ('openlibrary','google_books','itunes','manual')),
  ADD CONSTRAINT book_catalog_subjects_provider_chk
    CHECK (subjects_provider IS NULL OR subjects_provider IN
      ('openlibrary','google_books','itunes','manual')),
  ADD CONSTRAINT book_catalog_page_count_provider_chk
    CHECK (page_count_provider IS NULL OR page_count_provider IN
      ('openlibrary','google_books','itunes','manual'));

-- description_provider gains 'itunes' literal (new third source in refit).
-- Drop existing constraint (auto-named book_catalog_description_provider_check
-- by 20260502000001) and re-add with the widened set. IF EXISTS keeps the
-- migration idempotent across local re-runs.
ALTER TABLE book_catalog DROP CONSTRAINT IF EXISTS book_catalog_description_provider_check;
ALTER TABLE book_catalog DROP CONSTRAINT IF EXISTS book_catalog_description_provider_chk;
ALTER TABLE book_catalog
  ADD CONSTRAINT book_catalog_description_provider_chk
    CHECK (description_provider IS NULL OR description_provider IN
      ('openlibrary','google_books','itunes','manual'));

-- Replay-cron indexes. Partial WHERE-NULL keeps each tiny — only rows that
-- still need the field appear. The cron orders by last_attempted_at ASC NULLS
-- FIRST against the per-field replay candidates RPC (see 20260527000004).
CREATE INDEX book_catalog_replay_cover           ON book_catalog (cover_attempted_at)          WHERE storage_path IS NULL;
CREATE INDEX book_catalog_replay_description     ON book_catalog (description_attempted_at)    WHERE description IS NULL;
CREATE INDEX book_catalog_replay_publisher       ON book_catalog (publisher_attempted_at)      WHERE publisher IS NULL;
CREATE INDEX book_catalog_replay_published_date  ON book_catalog (published_date_attempted_at) WHERE published_date IS NULL;
CREATE INDEX book_catalog_replay_subjects        ON book_catalog (subjects_attempted_at)       WHERE subjects IS NULL;
CREATE INDEX book_catalog_replay_page_count      ON book_catalog (page_count_attempted_at)     WHERE page_count IS NULL;

COMMENT ON COLUMN book_catalog.cover_fail_reason IS
  'Per-field fail bucket — drives TTL ladder in _field_replay_due(). Null=success or never-attempted.';
COMMENT ON COLUMN book_catalog.cover_attempted_at IS
  'Last walker pass for cover. Null = never attempted; shouldAttempt() returns true.';
