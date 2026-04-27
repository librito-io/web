-- Mitigate "Auth RLS Initialization Plan" performance advisor warnings.
--
-- Bare `auth.uid()` inside USING / WITH CHECK is treated as a STABLE
-- function and re-evaluated for each row scanned. Wrapping it in
-- `(SELECT auth.uid())` lets Postgres cache the value for the lifetime
-- of the query — orders of magnitude faster on large result sets.
--
-- 11 policies in public.* flagged by the advisor + 2 storage.objects
-- policies in the book-transfers bucket (same class, not in advisor's
-- public-only audit but worth fixing here).

-- ---- profiles ----
ALTER POLICY "Users can read own profile" ON public.profiles
  USING ((SELECT auth.uid()) = id);

ALTER POLICY "Users can update own profile" ON public.profiles
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

-- ---- devices ----
ALTER POLICY "Users can read own devices" ON public.devices
  USING ((SELECT auth.uid()) = user_id);

-- ---- books ----
ALTER POLICY "Users can read own books" ON public.books
  USING ((SELECT auth.uid()) = user_id);

-- ---- highlights ----
ALTER POLICY "Users can read own highlights" ON public.highlights
  USING ((SELECT auth.uid()) = user_id);

-- ---- notes ----
ALTER POLICY "Users can read own notes" ON public.notes
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can create own notes" ON public.notes
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can update own notes" ON public.notes
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can delete own notes" ON public.notes
  USING ((SELECT auth.uid()) = user_id);

-- ---- book_transfers ----
ALTER POLICY "Users can read own transfers" ON public.book_transfers
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can create own transfers" ON public.book_transfers
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND (
      device_id IS NULL
      OR device_id IN (
        SELECT id FROM public.devices WHERE user_id = (SELECT auth.uid())
      )
    )
  );

-- ---- storage.objects (book-transfers bucket) ----
-- Not flagged by the public-schema advisor but same performance class.
ALTER POLICY "Users can upload book transfers" ON storage.objects
  WITH CHECK (
    bucket_id = 'book-transfers'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

ALTER POLICY "Users can read own book transfers" ON storage.objects
  USING (
    bucket_id = 'book-transfers'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
