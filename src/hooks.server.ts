import { createServerClient } from "@supabase/ssr";
import { sequence } from "@sveltejs/kit/hooks";
import { redirect, type Handle, type HandleServerError } from "@sveltejs/kit";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import { env as privateEnv } from "$env/dynamic/private";
import * as Sentry from "@sentry/sveltekit";
import { runWithContext, logger } from "$lib/server/log";
import { scrubEvent } from "$lib/sentry-scrub";
import { jsonError } from "$lib/server/errors";
import { LOCALE_COOKIE } from "$lib/i18n/locales";
import { resolveLocale } from "$lib/i18n/resolve";

// Sensitive vars (SENTRY_DSN among them) are redacted by `vercel pull`,
// so $env/static/private would inline an empty string into the prebuilt
// bundle. $env/dynamic/private reads at runtime where the value is real.
// See CLAUDE.md "Vercel Sensitive env vars require $env/dynamic/private".
if (privateEnv.SENTRY_DSN) {
  Sentry.init({
    dsn: privateEnv.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    // Attach the current JS execution stack to events whose error object
    // carries no usable `.stack` of its own — notably DOM AbortError from
    // a fetch() abort, which surfaces from the abort microtask with empty
    // frames. Without this, such events arrive as "No stacktrace available"
    // (see LIBRITO-WEB-G). Default is false; turning it on costs nothing and
    // restores the runbook's assumption that every error carries frames.
    attachStacktrace: true,
    sendDefaultPii: false,
    // Cast: scrubEvent uses a minimal ScrubableEvent shape rather than
    // Sentry's internal ErrorEvent type (see sentry-scrub.ts for why).
    // The runtime shape is structurally compatible — the cast just
    // sidesteps TS's parameter contravariance on the typed Sentry
    // callback. Double-cast through unknown because ErrorEvent has no
    // index signature (TS 10.x SDK type drift vs. original design).
    beforeSend: scrubEvent as unknown as NonNullable<
      Parameters<typeof Sentry.init>[0]
    >["beforeSend"],
  });
}

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

// Resolves the request locale (explicit cookie choice → Accept-Language
// → "en") into event.locals.locale, and rewrites app.html's static
// `<html lang="en" dir="ltr">` so first paint carries the correct
// language and text direction (RTL for Arabic) before any JS runs.
// The root layout load passes locals.locale to initI18n() so SSR text
// renders in the same locale the <html> tag declares. Issue #523.
//
// The replace targets the exact literal in app.html — keep the two in
// sync. transformPageChunk runs per chunk; the open tag sits in the
// first chunk and the replace is a no-op on the rest.
// Exported for direct unit testing (tests/hooks.server.test.ts).
export const localeSetup: Handle = async ({ event, resolve }) => {
  const locale = resolveLocale(
    event.cookies.get(LOCALE_COOKIE) ?? null,
    event.request.headers.get("accept-language"),
  );
  event.locals.locale = locale;
  const dir = locale === "ar" ? "rtl" : "ltr";
  return resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace(
        '<html lang="en" dir="ltr">',
        `<html lang="${locale}" dir="${dir}">`,
      ),
  });
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

// Single auth-check site for /app/** route tree. Covers page loads,
// form actions, and +server.ts endpoints uniformly — replaces the
// per-file `safeGetSession` + `if (!user) redirect/fail` blocks that
// used to live in each loader, action, and endpoint (issues #347/#348).
//
// Response policy:
//   - Page-load GETs (anything under /app/** that is NOT /app/api/*)
//     redirect to /auth/login with `?return_to=` so the login page can
//     deep-link the user back after sign-in (#349).
//   - /app/api/* are XHR/JSON endpoints by convention — they always
//     return 401 JSON regardless of method, because `fetch()` auto-
//     follows 303s and a redirect to HTML /auth/login crashes any
//     downstream JSON.parse on session expiry mid-page (#351).
//   - All other non-GET /app/** requests (form actions, etc.) also
//     return 401 JSON so client-side JS can show a "session expired"
//     toast and trigger a soft re-auth rather than losing form state
//     to a hard redirect.
//
// Populates `event.locals.user` and `event.locals.session` as non-null
// for downstream handlers; the App.Locals type stays nullable globally
// because anonymous routes (`/`, `/auth/*`) genuinely have null. Use
// `requireUser(event)` from $lib/server/auth to narrow at call sites.
// Exported for direct unit testing (tests/unit/app-auth-guard.test.ts).
// Production use is via `handle` below.
export const appAuthGuard: Handle = async ({ event, resolve }) => {
  if (event.route.id?.startsWith("/app")) {
    const { session, user } = await event.locals.safeGetSession();
    if (!session || !user) {
      const isXhrEndpoint = event.route.id.startsWith("/app/api/");
      if (event.request.method === "GET" && !isXhrEndpoint) {
        const returnTo = encodeURIComponent(
          event.url.pathname + event.url.search,
        );
        redirect(303, `/auth/login?return_to=${returnTo}`);
      }
      return jsonError(401, "unauthorized", "Session required");
    }
    event.locals.session = session;
    event.locals.user = user;
  }
  return resolve(event);
};

// Sentry's sentryHandle() tags route/method on every error and creates a
// request scope so captureException calls inside this request inherit the
// scope. Placed first in the sequence so all subsequent handlers' errors
// are scoped correctly. appAuthGuard runs after supabaseSetup so it can
// call event.locals.safeGetSession().
export const handle = sequence(
  Sentry.sentryHandle(),
  requestContext,
  localeSetup,
  supabaseSetup,
  appAuthGuard,
);

// SvelteKit calls handleError for unhandled errors thrown anywhere in
// load functions, server actions, or API routes. handleErrorWithSentry
// auto-captures them. We don't have a previous custom handleError to
// wrap; pass a no-op fallback that logs locally so self-hosters without
// Sentry still get a log line.
const fallbackHandleError: HandleServerError = ({ error, event }) => {
  logger().error(
    {
      event: "handle_error",
      route: event.route.id ?? "",
      method: event.request.method,
      error: error instanceof Error ? error.message : String(error),
    },
    "handle_error",
  );
};

export const handleError = Sentry.handleErrorWithSentry(fallbackHandleError);
