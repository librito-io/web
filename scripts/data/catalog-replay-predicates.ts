// Pure helpers driving the operator CLI's predicate-build step. Factored
// out from `catalog-replay.ts` for unit-testability — the CLI mainline
// has supabase-js side effects that vitest can't usefully cover, but the
// argument-validation + predicate-construction logic absolutely warrants
// coverage (operator-facing surface, one slip drops the wrong rows).
//
// Relative-path import: `tsx` running this file from `scripts/data/`
// resolves `../../src/lib/server/catalog/tracked-fields.ts` through
// node ESM filesystem resolution without needing `$lib` paths.

import {
  TRACKED_FIELDS,
  FAIL_REASONS,
  type TrackedField,
  type FailReason,
} from "../../src/lib/server/catalog/tracked-fields";

export { TRACKED_FIELDS, FAIL_REASONS };
export type { TrackedField, FailReason };

export function isTrackedField(v: string): v is TrackedField {
  return (TRACKED_FIELDS as readonly string[]).includes(v);
}

export function isFailReason(v: string): v is FailReason {
  return (FAIL_REASONS as readonly string[]).includes(v);
}

/**
 * Map a tracked field to the column the CLI's `--missing` mode queries.
 * Cover's value-presence discriminant is `storage_path`, not `cover`.
 * Every other field uses its own name.
 */
export function missingFieldColumn(field: TrackedField): string {
  return field === "cover" ? "storage_path" : field;
}

/**
 * Build the supabase-js `.or()` clause that matches rows where ANY
 * tracked field's `fail_reason` equals the operator-supplied reason.
 *
 * PostgREST `.or()` syntax: comma-separated `column.op.value` pairs,
 * outer parens implied by the call. Eight-character risk: a leading
 * space or a stray `,` breaks the parse silently. Tested.
 */
export function failReasonOrClause(reason: FailReason): string {
  return TRACKED_FIELDS.map((f) => `${f}_fail_reason.eq.${reason}`).join(",");
}

/**
 * Parse + validate the comma-separated `--fields` operator argument.
 * Returns the narrowed array on success, throws with operator-readable
 * message on first invalid token.
 */
export function parseFieldsArg(raw: string): TrackedField[] {
  const fields = raw.split(",").map((s) => s.trim());
  for (const f of fields) {
    if (!isTrackedField(f)) {
      throw new Error(
        `Unknown field "${f}". Valid: ${TRACKED_FIELDS.join(",")}`,
      );
    }
  }
  return fields as TrackedField[];
}

/**
 * Selected predicate mode the CLI runs. Discriminated so the caller can
 * dispatch without re-checking which CLI flag was set.
 */
export type PredicateMode =
  | { kind: "isbns"; isbns: string[] }
  | { kind: "missing"; field: TrackedField }
  | { kind: "by-fail-reason"; reason: FailReason };

/**
 * Validate exactly one of --isbns / --missing / --by-fail-reason is
 * supplied and return the discriminated mode. Throws on zero or >1.
 */
export function pickPredicateMode(args: {
  isbns?: string;
  missing?: string;
  byFailReason?: string;
}): PredicateMode {
  const present = [
    args.isbns ? "isbns" : null,
    args.missing ? "missing" : null,
    args.byFailReason ? "by-fail-reason" : null,
  ].filter((s): s is string => s !== null);

  if (present.length === 0) {
    throw new Error(
      "Pass one of --isbns <list>, --missing <field>, --by-fail-reason <reason>.",
    );
  }
  if (present.length > 1) {
    throw new Error(
      `Pass exactly one predicate mode; got --${present.join(" and --")}.`,
    );
  }

  if (args.isbns) {
    const isbns = args.isbns
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { kind: "isbns", isbns };
  }
  if (args.missing) {
    if (!isTrackedField(args.missing)) {
      throw new Error(`--missing must be one of ${TRACKED_FIELDS.join(",")}`);
    }
    return { kind: "missing", field: args.missing };
  }
  // byFailReason — present.length === 1 guarantee
  const reason = args.byFailReason!;
  if (!isFailReason(reason)) {
    throw new Error(
      `--by-fail-reason must be one of ${FAIL_REASONS.join(",")}`,
    );
  }
  return { kind: "by-fail-reason", reason };
}
