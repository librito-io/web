// vercel.ts
import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "sveltekit",
  // Cache the wordmark SVG so a reload serves it from disk cache instead of
  // revalidating. Static assets in `static/` ship with
  // `Cache-Control: public, max-age=0, must-revalidate` (SvelteKit's default
  // for unhashed files), which forces a conditional GET on every reload. Chrome
  // repaints the image seamlessly across that 304; Safari re-decodes and
  // re-paints it a beat after the static text, so the two /librito.svg logos
  // (hero + header) visibly flash on every refresh — Safari-only. `immutable`
  // means "don't revalidate on reload", which eliminates the round-trip and the
  // flash. The URL is stable, so a future logo change must bust the cache by
  // renaming the file (e.g. librito-v2.svg) — returning visitors keep the
  // cached copy until the URL changes. Guarded by
  // tests/lib/static-cache-headers.test.ts.
  headers: [
    {
      source: "/librito.svg",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=31536000, immutable",
        },
      ],
    },
  ],
  crons: [
    { path: "/api/cron/transfer-sweep", schedule: "0 3 * * *" },
    // Nightly replay 04:00 UTC — offsets from transfer-sweep (03:00) so
    // both daily cron loops don't compete for the same Vercel function
    // boot window under Hobby's ±59 min jitter. Picks up rows whose
    // per-field fail_reason TTL has elapsed (see _field_replay_due).
    { path: "/api/cron/catalog-replay", schedule: "0 4 * * *" },
    // 05:00 UTC — 1 hour after catalog-replay (04:00). Daily cadence catches
    // DLQ landings within QStash's 3-day retention window, with margin for
    // missed fires under Hobby's ±59 min jitter. Drains DLQ into
    // catalog_dlq_archive for operator inspection (admin UI under
    // /app/admin/catalog/[id]). Self-hoster gate is implicit on
    // !privateEnv.QSTASH_TOKEN inside the handler.
    { path: "/api/cron/catalog-dlq-drain", schedule: "0 5 * * *" },
    { path: "/api/cron/catalog-warmup", schedule: "0 8 * * 1" },
    // Mon 09:00 UTC fill-rate snapshot — same Mon-morning slot as
    // catalog-warmup. One row per week into catalog_fill_rate_history
    // for the admin sparkline; @sentry/sveltekit 10 dropped the metrics
    // API, so the table is the durable observability surface.
    { path: "/api/cron/catalog-fill-rate", schedule: "0 9 * * 1" },
    // 09:00 UTC offsets from transfer-sweep (03:00) and catalog-warmup
    // (Mon 08:00). Daily cadence is the natural granularity for catching
    // "started failing in the last week" against the 7-day window in
    // public.pg_cron_failure_summary().
    { path: "/api/cron/pg-cron-health", schedule: "0 9 * * *" },
  ],
  git: {
    deploymentEnabled: {
      main: false,
    },
  },
};
