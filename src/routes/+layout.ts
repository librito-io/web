import {
  createBrowserClient,
  createServerClient,
  isBrowser,
} from "@supabase/ssr";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import type { LayoutLoad } from "./$types";
import { initI18n, waitLocale } from "$lib/i18n";

export const load: LayoutLoad = async ({ data, depends, fetch }) => {
  depends("supabase:auth");

  initI18n();
  await waitLocale();

  const supabase = isBrowser()
    ? createBrowserClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
        global: { fetch },
      })
    : createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
        global: { fetch },
        cookies: {
          getAll() {
            return data.cookies;
          },
        },
      });

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  return { session, user: userError ? null : user, supabase };
};
