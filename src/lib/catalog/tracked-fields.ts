// Single source of truth for the per-field state model: which fields the
// resolver tracks and which fail-reason buckets gate retries. Standalone
// module (no $lib / no Database type imports) so the operator CLI can
// import via relative path without dragging in the SvelteKit-only env
// resolution chain.
//
// Lives under `$lib/catalog/` (not `$lib/server/catalog/`) because the
// admin UI renders the field list inside `+page.svelte` and SvelteKit's
// `$lib/server/*` boundary forbids client-bundle imports from there.
// No env reads, no DB code, no secrets — safe to ship into the browser.
//
// Editors of these literal unions: bump the DB CHECK constraints in
// migration 20260527000001 + every {field}_fail_reason CHECK; bump
// _field_replay_due in migration 20260527000004; bump the resolver's
// per-field walker; bump the admin form-action allowlist. Search the
// repo for the literal you're touching before editing.

export type TrackedField =
  | "cover"
  | "description"
  | "publisher"
  | "published_date"
  | "subjects"
  | "page_count";

export const TRACKED_FIELDS: readonly TrackedField[] = [
  "cover",
  "description",
  "publisher",
  "published_date",
  "subjects",
  "page_count",
] as const;

// Six fail_reason buckets driving the TTL ladder. Replay cron retries
// rate_limited / transient_error in 1h, provider_disabled in 24h,
// provider_empty_field in 30d, provider_no_data + exhausted in 90d.
// CHECK-constrained at the DB level per migration 20260527000001.
export type FailReason =
  | "rate_limited"
  | "transient_error"
  | "provider_disabled"
  | "provider_empty_field"
  | "provider_no_data"
  | "exhausted";

export const FAIL_REASONS: readonly FailReason[] = [
  "rate_limited",
  "transient_error",
  "provider_disabled",
  "provider_empty_field",
  "provider_no_data",
  "exhausted",
] as const;
