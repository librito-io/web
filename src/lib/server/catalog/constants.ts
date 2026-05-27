/**
 * Synthetic user ID used by cron-driven catalog resolves as the per-user
 * limiter key. NOT a real `auth.users` row — production never assigns
 * this UUID to any user. Carried by the replay cron + (future) operator
 * CLI when scheduled work isn't attributable to a specific viewer.
 *
 * Callers of `scheduleCatalogResolveIfAllowed` pass this with
 * `bypassUserLimit: true` so the per-user budget (10/min) doesn't cap a
 * 100-row replay batch at 10 items. Per-source limiters (OpenLibrary,
 * GoogleBooks, iTunes) still apply — those are the real upstream-
 * protection budgets.
 *
 * Generated once with `uuidgen` and pinned. Do not regenerate; the value
 * is referenced in log queries and Sentry breadcrumbs.
 */
export const SERVICE_USER_ID = "00000000-c47a-1090-0000-7e7c91ce17a0";
