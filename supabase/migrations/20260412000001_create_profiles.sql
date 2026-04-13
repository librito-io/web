-- ============================================================
-- PROFILES (extends Supabase Auth)
-- ============================================================
-- One profile per authenticated user. Auto-created on signup
-- via trigger on auth.users.

CREATE TABLE profiles (
  id           uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE profiles IS 'User profiles, auto-created on signup via trigger';

-- Auto-create a profile row when a new user signs up in Supabase Auth.
-- SECURITY DEFINER: runs with the function owner's permissions (needed
-- to write to public.profiles from the auth schema trigger context).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
