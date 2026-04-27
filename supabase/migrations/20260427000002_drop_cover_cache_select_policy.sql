-- Mitigate "Public Bucket Allows Listing" advisor warning on cover-cache.
--
-- Public buckets (`public = true` on storage.buckets) serve files via
-- /storage/v1/object/public/<bucket>/<path> WITHOUT RLS evaluation. The
-- broad SELECT policy "Anyone can read cached covers" only enables the
-- LIST operation against storage.objects, which lets clients enumerate
-- every cached cover (every ISBN in the library) without authenticating.
--
-- We never need clients to list cover-cache — the web app fetches by
-- known filename (computed from ISBN), and uploads happen server-side via
-- service_role (which bypasses RLS). Drop the policy entirely. URL
-- fetches continue working because cover-cache stays public.

DROP POLICY IF EXISTS "Anyone can read cached covers" ON storage.objects;
