-- 20260528000001_catalog_dlq_archive.sql
--
-- Durable archive of QStash DLQ entries for catalog cold-miss resolves.
-- /api/cron/catalog-dlq-drain reads DLQ contents via Client.dlq.listMessages,
-- inserts one row per message, and deletes from QStash to free the 3-day
-- retention slot. Operator inspects matches under
-- /app/admin/catalog/[id] and triggers manual re-queue via the existing
-- requeue_catalog_resolve RPC.
--
-- Retention: forever (audit log). At spec-projected 100 entries/day,
-- ~36MB/year — under Supabase free-tier 500MB cap for >10 years.
--
-- Admin SELECT only via RLS; service_role bypasses RLS for drain cron
-- writes and admin manual-requeue UPDATEs. Default ALTER DEFAULT
-- PRIVILEGES table grants left intact per CLAUDE.md "Function EXECUTE
-- grants" — the function-revoke story applies to RPCs, not tables.

CREATE TABLE catalog_dlq_archive (
  id                    BIGSERIAL PRIMARY KEY,
  message_id            TEXT NOT NULL UNIQUE,
  payload               JSONB NOT NULL,
  first_failed_at       TIMESTAMPTZ NOT NULL,
  fail_reason           TEXT,
  archived_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  manually_requeued_at  TIMESTAMPTZ
);

CREATE INDEX catalog_dlq_archive_payload_isbn
  ON catalog_dlq_archive ((payload->'item'->>'isbn'));
CREATE INDEX catalog_dlq_archive_payload_title_author
  ON catalog_dlq_archive (
    (payload->'item'->>'title'),
    (payload->'item'->>'author')
  );
CREATE INDEX catalog_dlq_archive_archived_at
  ON catalog_dlq_archive (archived_at DESC);

ALTER TABLE catalog_dlq_archive ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS by design (drain cron + admin form actions).
-- authenticated read-only when the row's profile is_admin=true.
CREATE POLICY catalog_dlq_archive_admin_select ON catalog_dlq_archive
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
       WHERE profiles.id = auth.uid()
         AND profiles.is_admin = true
    )
  );

-- No INSERT/UPDATE/DELETE policies on authenticated; service_role only.

COMMENT ON TABLE catalog_dlq_archive IS
  'Durable archive of QStash DLQ entries for catalog cold-miss resolves. '
  'Drain cron writes; admin UI reads + UPDATEs manually_requeued_at on '
  'operator-driven re-queue.';
