/**
 * Minimal local interface covering the Sentry event shape we touch.
 * Defined locally instead of importing `ErrorEvent` from
 * `@sentry/sveltekit` (or `@sentry/core`) for two reasons:
 *   1. Avoids a brittle dependency on Sentry's internal type re-exports
 *      across SDK versions.
 *   2. Documents exactly which event fields the scrub touches.
 * `Sentry.init`'s `beforeSend` option accepts any function returning the
 * event (or null), so the structurally compatible signature here works
 * at the use site in hooks.server.ts via parameter inference.
 */
export interface ScrubableEvent {
  event_id?: string;
  timestamp?: number;
  request?: {
    headers?: Record<string, string>;
    data?: unknown;
    query_string?: unknown;
  };
  contexts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Base-name field set whose values get replaced with `[REDACTED]`
 * anywhere they appear in a Sentry event payload via `redactDeep`'s
 * recursive walk. Sibling to pino's redact list in
 * src/lib/server/log.ts. Two structural differences:
 *   - pino lists each name twice (`field` + `*.field`) to cover root +
 *     nested; this set relies on `redactDeep` recursing into nested
 *     objects, so one entry per name suffices.
 *   - pino lists `req.headers.authorization` + `req.headers.cookie` as
 *     explicit paths; this scrub deletes those headers structurally in
 *     `scrubEvent` (see header-strip block below), not via this set.
 * Base-name additions here should also be added to pino's `paths`
 * (root + `*.` form) and vice versa. Header additions are pino-only —
 * add a sibling `delete headers.<name>` in `scrubEvent` to mirror.
 *
 * Scope: `scrubEvent` is wired as `beforeSend` in BOTH `hooks.server.ts`
 * and `hooks.client.ts`, so this set redacts client-originated Sentry
 * events as well. Pino runs server-side only, so REDACTED_FIELDS is the
 * sole redaction layer for browser-side errors — never reason "pino
 * already covers it" when deciding whether to add an entry.
 */
export const REDACTED_FIELDS = [
  "token",
  "api_token_hash",
  "password",
  "email",
  "userEmail",
  "privateKey",
  "jwk",
] as const;

const REDACTED_SET = new Set<string>(REDACTED_FIELDS);
const REDACTED = "[REDACTED]";

/**
 * Recursively replaces values of REDACTED_FIELDS keys with [REDACTED].
 * Assumes acyclic, bounded-depth input. No cycle guard or depth cap; if
 * a future caller passes adversarial graphs, add one then.
 *
 * Non-plain objects (Date, RegExp, Map, Set, class instances) are returned
 * as-is. Iterating them via Object.entries would silently collapse them
 * to `{}` — e.g. `Sentry.setExtra("at", new Date())` would lose the Date.
 */
function redactDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactDeep);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACTED_SET.has(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactDeep(v);
    }
  }
  return out;
}

/**
 * `beforeSend` hook for Sentry.init. Single point that decides what
 * leaves the process boundary. Drops authorization + cookie headers
 * entirely; recursively replaces sensitive field values in request.data,
 * request.query_string, contexts, extra, and tags.
 *
 * Mutates `event` in place by replacing scrubbed fields and returns the
 * same reference. Sentry calls beforeSend once per event and discards the
 * input, so in-place mutation is safe.
 *
 * Always returns the event (never null) — we want every captured error
 * to reach Sentry, just scrubbed.
 */
export function scrubEvent(
  event: ScrubableEvent,
  _hint?: unknown,
): ScrubableEvent | null {
  if (event.request?.headers) {
    const headers = { ...event.request.headers };
    // Sentry SDK lowercases headers before populating request.headers, so
    // the lowercase delete is sufficient. If that ever changes, add a
    // case-insensitive sweep here.
    delete headers.authorization;
    delete headers.cookie;
    event.request.headers = headers;
  }

  if (event.request?.data !== undefined) {
    event.request.data = redactDeep(event.request.data);
  }

  if (event.request?.query_string !== undefined) {
    event.request.query_string = redactDeep(event.request.query_string);
  }

  if (event.contexts) {
    event.contexts = redactDeep(event.contexts) as Record<string, unknown>;
  }

  if (event.extra) {
    event.extra = redactDeep(event.extra) as Record<string, unknown>;
  }

  if (event.tags) {
    event.tags = redactDeep(event.tags) as Record<string, unknown>;
  }

  // event.message is intentionally not pattern-scrubbed here. The
  // canonical defense is "do not put secrets in error messages" — see
  // docs/operations/sentry-runbook.md if a future incident forces a
  // pattern-scrub addition.

  return event;
}
