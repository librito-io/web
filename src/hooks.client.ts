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
// $env/dynamic/public reads PUBLIC_* at SSR time from process.env and
// publishes the values to the browser via SvelteKit's injected env
// script. Values must be set in Vercel env (not just at build time) —
// PUBLIC_SENTRY_DSN and PUBLIC_VERCEL_ENV are set there as Encrypted
// vars. PUBLIC_VERCEL_GIT_COMMIT_SHA is not currently wired (Vercel
// changes VERCEL_GIT_COMMIT_SHA per build, no static value to set) —
// the release tag is omitted; follow-up will pipe it via the layout
// server load.
//
// Earlier attempts that didn't work:
//   - vite.config.ts mirror of VERCEL_* → PUBLIC_VERCEL_*: build-time
//     process.env mutation doesn't survive to Vercel function runtime
//     where SvelteKit's dynamic-public scan runs.
//   - import.meta.env.PUBLIC_*: Vite's default envPrefix is "VITE_",
//     so PUBLIC_* refs collapsed to undefined in the browser bundle.
import { env as publicEnv } from "$env/dynamic/public";
import type { HandleClientError } from "@sveltejs/kit";
import {
  scrubEvent,
  isSvelteKitFetchNoise,
  isStaleModuleImportNoise,
} from "$lib/sentry-scrub";
import type { ScrubableEvent } from "$lib/sentry-scrub";

// Release SHA injection: the Sentry Vite plugin (sentrySvelteKit in
// vite.config.ts) bakes `globalThis.SENTRY_RELEASE = { id: <SHA> }` into
// the browser bundle at build time using Vercel's VERCEL_GIT_COMMIT_SHA.
// The SDK does NOT auto-read this into the event-level `release` field
// (it only flows to the Dynamic Sampling Context), so the Tags panel
// shows no `release` value without this explicit forward. Verified on
// PR #329 prod event: _dsc.release was set, event.release was null.
const sentryRelease = (
  globalThis as unknown as { SENTRY_RELEASE?: { id?: string } }
).SENTRY_RELEASE?.id;

if (publicEnv.PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: publicEnv.PUBLIC_SENTRY_DSN,
    environment: publicEnv.PUBLIC_VERCEL_ENV || "development",
    release: sentryRelease,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // See hooks.server.ts: attach the execution stack to events whose
    // error carries no `.stack` (stackless DOM exceptions). Mirrors server
    // init so browser + server error fidelity match.
    attachStacktrace: true,
    sendDefaultPii: false,
    // Cast mirrors hooks.server.ts: scrubEvent uses a minimal
    // ScrubableEvent shape rather than Sentry's internal ErrorEvent
    // type. Runtime shape is structurally compatible.
    //
    // Pipeline: drop SvelteKit hover-preload AbortError noise first
    // (see isSvelteKitFetchNoise — issue #412) and stale-chunk dynamic-
    // import failures (see isStaleModuleImportNoise — issue #413), then
    // scrub the rest. Both filters are browser-only; server-side
    // scrubEvent in hooks.server.ts stays unchanged because both
    // signatures originate client-side.
    beforeSend: ((event: ScrubableEvent, hint: unknown) => {
      if (isSvelteKitFetchNoise(event)) return null;
      if (isStaleModuleImportNoise(event)) return null;
      return scrubEvent(event, hint);
    }) as unknown as NonNullable<
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
