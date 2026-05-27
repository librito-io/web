import type {
  BookCatalogRowFields,
  FailReason,
  FieldProvider,
  ResolveCtx,
  TrackedField,
} from "./types";

// Per-leg outcome from one provider attempt on one field. Walker aggregates
// these into a single FailReason if no leg succeeds. Distinguishing kinds
// drives the TTL ladder downstream: rate_limited / transient retry in 1h,
// disabled in 24h, empty in 30d, no_data + exhausted in 90d.
//
// `success`  — leg returned a usable value; walker stops + reports provider.
// `empty`    — provider had an item for the lookup but the field was blank.
// `rate_limited` — leg's limiter denied before the upstream call.
// `transient`    — upstream threw (5xx, timeout, network).
// `disabled` — provider not configured (e.g. GB API key unset; iTunes
//              disabled on TA path because no ISBN to query by).
// `no_data`  — upstream answered 200 with no matching item for the lookup.
export type LegOutcome<T> =
  | { kind: "success"; value: T; provider: FieldProvider }
  | { kind: "empty"; provider: FieldProvider }
  | { kind: "rate_limited" }
  | { kind: "transient"; error: unknown }
  | { kind: "disabled" }
  | { kind: "no_data"; provider: FieldProvider };

export interface FieldChain<T> {
  field: TrackedField;
  legs: Array<(ctx: ResolveCtx) => Promise<LegOutcome<T>>>;
}

export interface ChainResult<T> {
  value: T | null;
  provider: FieldProvider | null;
  fail_reason: FailReason | null;
}

// Iterate legs in order. First `success` short-circuits and returns
// `{ value, provider, fail_reason: null }`. Otherwise the collected
// negative outcomes feed into `aggregate()` to derive one FailReason.
// Empty `legs` returns `exhausted` so callers can skip the walker pass
// without a special case at the call site.
export async function walkChain<T>(
  chain: FieldChain<T>,
  ctx: ResolveCtx,
): Promise<ChainResult<T>> {
  const outcomes: LegOutcome<T>[] = [];
  for (const leg of chain.legs) {
    const outcome = await leg(ctx);
    if (outcome.kind === "success") {
      return {
        value: outcome.value,
        provider: outcome.provider,
        fail_reason: null,
      };
    }
    outcomes.push(outcome);
  }
  return { value: null, provider: null, fail_reason: aggregate(outcomes) };
}

// Priority biases toward "retry sooner" reasons when outcomes are mixed.
// Spec line 504-510. Order: rate_limited > transient > all-disabled >
// any-empty > all-no_data > exhausted. The any-empty branch is checked
// BEFORE the all-no_data branch, so a mixed empty+no_data row resolves
// to provider_empty_field (30d TTL) rather than provider_no_data (90d).
// A row with disabled + no_data (no empty / rate_limited / transient)
// falls through every branch and lands on `exhausted`.
function aggregate<T>(outcomes: LegOutcome<T>[]): FailReason {
  if (outcomes.length === 0) return "exhausted";
  if (outcomes.some((o) => o.kind === "rate_limited")) return "rate_limited";
  if (outcomes.some((o) => o.kind === "transient")) return "transient_error";
  if (outcomes.every((o) => o.kind === "disabled")) return "provider_disabled";
  if (outcomes.some((o) => o.kind === "empty")) return "provider_empty_field";
  if (outcomes.every((o) => o.kind === "no_data")) return "provider_no_data";
  return "exhausted";
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// TTL ladder for the per-field replay predicate. Mirrors the SQL
// `_field_replay_due()` helper (migration 20260527000004) so SQL replay
// selection and TS resolver gating use the same boundary. Strict `>`
// matches the SQL `>` — a row exactly at TTL becomes due on the next pass.
const TTL_MS: Record<FailReason, number> = {
  rate_limited: 1 * HOUR_MS,
  transient_error: 1 * HOUR_MS,
  provider_disabled: 24 * HOUR_MS,
  provider_empty_field: 30 * DAY_MS,
  provider_no_data: 90 * DAY_MS,
  exhausted: 90 * DAY_MS,
};

// Per-field gate evaluated before walking the chain. Returns true when the
// field is unpopulated AND either never-attempted (attempted_at null) or
// past its fail_reason TTL window.
//
// Populated-field discriminant is field-specific:
//   - cover:      storage_path != null
//   - subjects:   non-empty array
//   - page_count: non-null number
//   - description / publisher / published_date: same-named column non-null
//
// fail_reason null with attempted_at set is treated as success (no
// re-attempt) — the resolver clears fail_reason on a write that populated
// the field, so this state means "we wrote a value once".
export function shouldAttempt(
  field: TrackedField,
  row: Partial<BookCatalogRowFields>,
  now: Date,
): boolean {
  if (rowFieldIsPopulated(row, field)) return false;
  const attemptedAt = row[
    `${field}_attempted_at` as keyof BookCatalogRowFields
  ] as string | null | undefined;
  const reason = row[`${field}_fail_reason` as keyof BookCatalogRowFields] as
    | FailReason
    | null
    | undefined;
  if (!attemptedAt) return true;
  if (reason == null) return false;
  const age = now.getTime() - new Date(attemptedAt).getTime();
  return age > TTL_MS[reason];
}

function rowFieldIsPopulated(
  row: Partial<BookCatalogRowFields>,
  field: TrackedField,
): boolean {
  if (field === "cover") return row.storage_path != null;
  if (field === "subjects") return (row.subjects?.length ?? 0) > 0;
  // The remaining tracked fields (description, publisher, published_date,
  // page_count) live in same-named columns on the row.
  return row[field as keyof BookCatalogRowFields] != null;
}
