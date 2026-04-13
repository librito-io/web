-- ============================================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================================
-- Principle: users can only access their own data from the browser.
-- Server-side API routes (device sync, pairing, transfers) use
-- the service_role key and bypass RLS entirely.
--
-- Tables with no client-side policies (pairing_codes) still have
-- RLS enabled — this means the anon/authenticated roles have zero
-- access, which is the secure default.

-- ---- profiles ----
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ---- devices ----
-- Read-only from browser (view paired devices).
-- All mutations (create, rename, revoke) happen server-side via
-- API routes using service_role. This prevents browser-side
-- tampering with sensitive fields (api_token_hash, revoked_at).
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own devices"
  ON devices FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ---- pairing_codes ----
-- All operations happen server-side (service_role).
-- RLS enabled with no policies = zero client access.
ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;

-- ---- books ----
-- Read from browser (display library). Write happens server-side (sync API).
ALTER TABLE books ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own books"
  ON books FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ---- highlights ----
-- Read from browser (display highlights). Write happens server-side (sync API).
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own highlights"
  ON highlights FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ---- notes ----
-- Full CRUD from browser (user creates/edits/deletes notes in web app).
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notes"
  ON notes FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own notes"
  ON notes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notes"
  ON notes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own notes"
  ON notes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---- book_transfers ----
-- Read + insert from browser (view transfers, upload EPUBs).
-- Status updates (downloaded/expired) happen server-side.
ALTER TABLE book_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own transfers"
  ON book_transfers FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own transfers"
  ON book_transfers FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (
      device_id IS NULL
      OR device_id IN (SELECT id FROM devices WHERE user_id = auth.uid())
    )
  );

-- ---- cover_cache ----
-- Read for any authenticated user (covers are shared across users).
-- Write happens server-side only (fetch from Open Library/Google Books).
ALTER TABLE cover_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Any authenticated user can read covers"
  ON cover_cache FOR SELECT
  TO authenticated
  USING (true);
