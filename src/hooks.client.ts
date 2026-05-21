// src/hooks.client.ts
//
// Browser-side Sentry SDK init + handleError wrap. Gated on
// PUBLIC_SENTRY_DSN — self-hosters who leave it unset get zero events
// sent and zero bundle-runtime overhead (init is the no-op skip path).
//
// PUBLIC_SENTRY_DSN must be Vercel "Encrypted" type, NOT "Sensitive".
// Sensitive vars are redacted to empty strings by `vercel pull`, which
// would bake an empty DSN into the browser bundle and the init below
// would silently no-op. See CLAUDE.md Environment Variables note on
// the Encrypted-vs-Sensitive PUBLIC_* rule.
//
// Privacy posture (see spec §"Privacy Posture"):
//   - sendDefaultPii: false (no IP, no email, no cookie/header
//     auto-attachment beyond the scrubber's allowlist).
//   - tracesSampleRate: 0 + replays*: 0 (Phase 2 ships error capture
//     only; performance + Session Replay deferred).
//   - beforeSend: shared scrubEvent — same redaction list as server.
//   - Sentry org-level "Prevent Storing of IP Addresses" toggle ON
//     (one-time manual operator step; documented in runbook).
import * as Sentry from "@sentry/sveltekit";
import { env as publicEnv } from "$env/dynamic/public";
import type { HandleClientError } from "@sveltejs/kit";
import { scrubEvent } from "$lib/sentry-scrub";

if (publicEnv.PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: publicEnv.PUBLIC_SENTRY_DSN,
    environment: publicEnv.PUBLIC_VERCEL_ENV ?? "development",
    release: publicEnv.PUBLIC_VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,
    // Cast mirrors hooks.server.ts: scrubEvent uses a minimal
    // ScrubableEvent shape rather than Sentry's internal ErrorEvent
    // type. Runtime shape is structurally compatible.
    beforeSend: scrubEvent as unknown as NonNullable<
      Parameters<typeof Sentry.init>[0]
    >["beforeSend"],
  });
}

// SvelteKit calls handleError for unhandled errors thrown in any client-
// side render path, load function, or event handler. Default integrations
// (BrowserApiErrors, Breadcrumbs, GlobalHandlers, LinkedErrors,
// HttpContext, Dedupe) stay ON — they provide fetch interception,
// console breadcrumbs, navigation tracking. ~40-60 KB gzip overhead.
const fallback: HandleClientError = ({ error }) => {
  // Self-hoster path with no Sentry DSN — preserve a console log
  // so the browser console still surfaces something on crashes.
  // eslint-disable-next-line no-console
  console.error(error);
};

export const handleError = Sentry.handleErrorWithSentry(fallback);
