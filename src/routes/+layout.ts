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
import { initI18n } from "$lib/i18n";

export const load: LayoutLoad = async ({ data, depends, fetch }) => {
  depends("supabase:auth");

  // Server-resolved locale (cookie → Accept-Language → "en"); awaiting
  // initI18n guarantees messages are loaded before render on both sides.
  await initI18n(data.locale);

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
