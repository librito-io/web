-- Harden handle_new_user against search_path injection.
-- Mirrors 20260427000001_harden_update_updated_at_search_path.sql, which
-- pinned update_updated_at to search_path = '' for the same advisor class.
-- handle_new_user was missed in that pass: it was SECURITY DEFINER but
-- left at SET search_path = public, which still inherits an attacker-
-- controllable component (any object the attacker can create in public
-- could shadow the unqualified resolution path).
--
-- Body is already fully qualified (INSERT INTO public.profiles), so the
-- lock-down is purely defence-in-depth: the next edit can't regress
-- without the guard catching it.
--
-- pg_proc audit performed before writing this migration confirmed
-- handle_new_user is the only SECURITY DEFINER function in the public
-- schema (SELECT proname, prosecdef, proconfig FROM pg_proc WHERE
-- pronamespace = 'public'::regnamespace AND prosecdef = true), so no
-- other functions need the same treatment in this PR.
--
-- The on_auth_user_created trigger does not need recreation; CREATE OR
-- REPLACE FUNCTION updates the body in place and preserves existing
-- grants (so the REVOKE EXECUTE from 20260427000003 stays in effect).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$;
