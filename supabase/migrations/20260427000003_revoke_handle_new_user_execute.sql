-- Mitigate "Public Can Execute SECURITY DEFINER Function" advisor warning
-- on public.handle_new_user.
--
-- The function is invoked by the on_auth_user_created trigger on
-- auth.users; it has no legitimate caller from the API surface. Because
-- it lives in `public`, PostgREST exposes it as /rest/v1/rpc/
-- handle_new_user — anon clients can hit this and execute it with the
-- function owner's privileges (SECURITY DEFINER).
--
-- Revoking EXECUTE from anon/authenticated/PUBLIC closes that surface.
-- PostgreSQL does NOT check EXECUTE permission when a function is
-- invoked via trigger, so the on_auth_user_created trigger continues to
-- fire normally on signup. service_role retains its grants via Supabase
-- defaults and is unaffected.

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
