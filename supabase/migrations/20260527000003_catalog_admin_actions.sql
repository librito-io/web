-- 20260527000003_catalog_admin_actions.sql
--
-- Durable audit table for admin mutations on book_catalog. Every action
-- via /app/admin (save_description, takedown, upload_cover, set_isbn,
-- requeue) writes one row capturing before+after JSONB snapshots.
-- Admins read their own actions only; writes are service-role only.

CREATE TABLE catalog_admin_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES auth.users(id),
  catalog_id    uuid NOT NULL REFERENCES book_catalog(id) ON DELETE CASCADE,
  isbn          text,
  action        text NOT NULL CHECK (action IN
    ('save_description','takedown','upload_cover','set_isbn','requeue')),
  before_jsonb  jsonb,
  after_jsonb   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE catalog_admin_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read own actions" ON catalog_admin_actions
  FOR SELECT TO authenticated
  USING (
    admin_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin)
  );

-- No INSERT/UPDATE/DELETE policies on authenticated; RLS denies by default.
-- Writes go through service-role (admin_apply_action RPC + admin form actions).

CREATE INDEX catalog_admin_actions_isbn     ON catalog_admin_actions(isbn);
CREATE INDEX catalog_admin_actions_admin    ON catalog_admin_actions(admin_user_id, created_at DESC);
CREATE INDEX catalog_admin_actions_catalog  ON catalog_admin_actions(catalog_id, created_at DESC);

COMMENT ON TABLE catalog_admin_actions IS
  'Durable audit trail of operator mutations on book_catalog. Self-scoped '
  'RLS — admins read own rows only. Cross-admin visibility deferred to '
  'multi-admin (out of refit scope).';
