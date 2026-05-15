import { createServerClient } from "@supabase/ssr";
import { sequence } from "@sveltejs/kit/hooks";
import type { Handle } from "@sveltejs/kit";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import { runWithContext } from "$lib/server/log";

const requestContext: Handle = async ({ event, resolve }) => {
  const requestId =
    event.request.headers.get("x-vercel-id") ?? crypto.randomUUID();
  event.locals.requestId = requestId;
  return runWithContext(
    {
      requestId,
      route: event.route.id ?? undefined,
      method: event.request.method,
    },
    async () => {
      const response = await resolve(event, {
        filterSerializedResponseHeaders(name) {
          return name === "content-range" || name === "x-supabase-api-version";
        },
      });
      response.headers.set("x-request-id", requestId);
      return response;
    },
  );
};

const supabaseSetup: Handle = async ({ event, resolve }) => {
  event.locals.supabase = createServerClient(
    PUBLIC_SUPABASE_URL,
    PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => event.cookies.getAll(),
        setAll: (
          cookiesToSet: {
            name: string;
            value: string;
            options: Record<string, unknown>;
          }[],
        ) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            event.cookies.set(name, value, { ...options, path: "/" });
          });
        },
      },
    },
  );

  event.locals.safeGetSession = async () => {
    const {
      data: { session },
    } = await event.locals.supabase.auth.getSession();
    if (!session) return { session: null, user: null };

    const {
      data: { user },
      error,
    } = await event.locals.supabase.auth.getUser();
    if (error) return { session: null, user: null };
    return { session, user };
  };

  return resolve(event);
};

export const handle = sequence(requestContext, supabaseSetup);
