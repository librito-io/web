-- Mitigate "Function Search Path Mutable" advisor warning on
-- public.update_updated_at. Without an explicit search_path, the function
-- inherits the caller's session search_path; an attacker with CREATE on
-- some schema could shadow now() and have the trigger execute their
-- version. Pin search_path = '' and fully-qualify the one builtin.

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;
