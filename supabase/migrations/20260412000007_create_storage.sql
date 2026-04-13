-- ============================================================
-- STORAGE BUCKETS
-- ============================================================
-- book-transfers: private, temporary EPUB queue (deleted after device download)
-- cover-cache:    public read, shared cover images from Open Library/Google Books

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'book-transfers',
  'book-transfers',
  false,
  52428800,  -- 50 MB max per file
  ARRAY['application/epub+zip', 'application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cover-cache',
  'cover-cache',
  true,
  5242880,  -- 5 MB max per file
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- STORAGE POLICIES
-- ============================================================
-- Path convention for book-transfers: {user_id}/{transfer_id}/{filename}
-- This lets the policy enforce that users can only upload to their own folder.

-- book-transfers: authenticated users can upload to their own folder
CREATE POLICY "Users can upload book transfers"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'book-transfers'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- book-transfers: users can view their own uploads (for transfer status UI)
CREATE POLICY "Users can read own book transfers"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'book-transfers'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- cover-cache: anyone can read (public bucket, shared covers)
CREATE POLICY "Anyone can read cached covers"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'cover-cache');
