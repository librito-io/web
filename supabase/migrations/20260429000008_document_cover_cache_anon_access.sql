-- D3 — `public.cover_cache` SELECT policy is `TO authenticated USING (true)`.
--
-- Verified 2026-04-29: no anon-key path in src/ reads `cover_cache`, and no
-- public share / embed surface is planned in docs/. The current scope is
-- correct as defence-in-depth, but the table read silently returns zero
-- rows under the anon role, so a future contributor adding a public
-- share/embed page that reads cover_cache directly from the browser would
-- hit a hard-to-debug rabbit hole (RLS rejection looks like an empty
-- result, not an error).
--
-- The cover-cache Storage bucket itself is `public = true`
-- (20260412000007:17-25) — files are served via
-- `/storage/v1/object/public/cover-cache/<path>` without RLS evaluation.
-- Public surfaces should fetch covers via that URL (resolved server-side
-- from ISBN → storage_path), or via a server-side API route using
-- service_role to read the table — never via anon-key PostgREST against
-- this table.

COMMENT ON POLICY "Any authenticated user can read covers" ON public.cover_cache IS
  'Intentional — anon role cannot read cover_cache. Public embed/share '
  'pages should fetch covers via the public cover-cache Storage bucket '
  'directly (/storage/v1/object/public/cover-cache/<path>) using URLs '
  'resolved server-side, OR via a server-side API route using '
  'service_role. The table row itself (ISBN → storage_path) is treated '
  'as authenticated-only metadata even though the underlying file is '
  'world-readable. See audit issue D3 (2026-04-29).';
