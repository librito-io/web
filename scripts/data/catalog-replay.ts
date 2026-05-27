#!/usr/bin/env -S npx tsx
//
// Operator CLI for catalog row requeue. Wraps requeue_catalog_resolve(id,
// fields[]) via service-role Supabase and (optionally) triggers the
// nightly cron immediately so the operator doesn't wait until 04:00 UTC.
//
// Usage:
//   tsx scripts/data/catalog-replay.ts --isbns 9780...,9781... --fields description,cover
//   tsx scripts/data/catalog-replay.ts --missing description --fields description
//   tsx scripts/data/catalog-replay.ts --by-fail-reason rate_limited --fields cover
//   tsx scripts/data/catalog-replay.ts --isbns ... --fields ... --dry-run
//
// Predefined predicates only — no free-form WHERE clause. Spec safety
// note: operator input never assembles SQL.
//
// Env required: PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. The
// service-role key bypasses RLS for the requeue mutation (the RPC's
// EXECUTE is service-role only).

import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";

const TRACKED_FIELDS = [
  "cover",
  "description",
  "publisher",
  "published_date",
  "subjects",
  "page_count",
] as const;
type TrackedField = (typeof TRACKED_FIELDS)[number];

const FAIL_REASONS = [
  "rate_limited",
  "transient_error",
  "provider_disabled",
  "provider_empty_field",
  "provider_no_data",
  "exhausted",
] as const;
type FailReason = (typeof FAIL_REASONS)[number];

function isTrackedField(v: string): v is TrackedField {
  return (TRACKED_FIELDS as readonly string[]).includes(v);
}

function isFailReason(v: string): v is FailReason {
  return (FAIL_REASONS as readonly string[]).includes(v);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      isbns: { type: "string" },
      missing: { type: "string" },
      "by-fail-reason": { type: "string" },
      fields: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "supabase-url": { type: "string" },
      "service-role-key": { type: "string" },
    },
  });

  const url = values["supabase-url"] ?? process.env.PUBLIC_SUPABASE_URL;
  const key =
    values["service-role-key"] ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Set PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the env, " +
        "or pass --supabase-url / --service-role-key.",
    );
  }

  if (!values.fields) {
    throw new Error(
      `--fields required. Pass a comma-separated subset of: ${TRACKED_FIELDS.join(
        ",",
      )}`,
    );
  }
  const fields = values.fields.split(",").map((s) => s.trim());
  for (const f of fields) {
    if (!isTrackedField(f)) {
      throw new Error(
        `Unknown field "${f}". Valid: ${TRACKED_FIELDS.join(",")}`,
      );
    }
  }

  const modes = [
    values.isbns ? "isbns" : null,
    values.missing ? "missing" : null,
    values["by-fail-reason"] ? "by-fail-reason" : null,
  ].filter(Boolean);
  if (modes.length === 0) {
    throw new Error(
      "Pass one of --isbns <list>, --missing <field>, --by-fail-reason <reason>.",
    );
  }
  if (modes.length > 1) {
    throw new Error(
      `Pass exactly one predicate mode; got --${modes.join(" and --")}.`,
    );
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });

  type Candidate = {
    id: string;
    isbn: string | null;
    title: string | null;
    author: string | null;
  };
  let candidates: Candidate[];

  if (values.isbns) {
    const isbns = values.isbns
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const { data, error } = await admin
      .from("book_catalog")
      .select("id, isbn, title, author")
      .in("isbn", isbns);
    if (error) throw new Error(error.message);
    candidates = (data ?? []) as Candidate[];
  } else if (values.missing) {
    const field = values.missing;
    if (!isTrackedField(field)) {
      throw new Error(`--missing must be one of ${TRACKED_FIELDS.join(",")}`);
    }
    // Cover's value-presence discriminant is storage_path, not "cover".
    const col = field === "cover" ? "storage_path" : field;
    const { data, error } = await admin
      .from("book_catalog")
      .select("id, isbn, title, author")
      .is(col, null)
      .limit(500);
    if (error) throw new Error(error.message);
    candidates = (data ?? []) as Candidate[];
  } else {
    const reason = values["by-fail-reason"]!;
    if (!isFailReason(reason)) {
      throw new Error(
        `--by-fail-reason must be one of ${FAIL_REASONS.join(",")}`,
      );
    }
    const orClause = TRACKED_FIELDS.map(
      (f) => `${f}_fail_reason.eq.${reason}`,
    ).join(",");
    const { data, error } = await admin
      .from("book_catalog")
      .select("id, isbn, title, author")
      .or(orClause)
      .limit(500);
    if (error) throw new Error(error.message);
    candidates = (data ?? []) as Candidate[];
  }

  console.log(
    `Found ${candidates.length} candidate rows. Requeue fields: ${fields.join(",")}`,
  );

  if (values["dry-run"]) {
    for (const c of candidates) {
      console.log(`  ${c.id}  ${c.isbn ?? "(ta)"}  ${c.title ?? "?"}`);
    }
    console.log("Dry-run — no requeue executed.");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const c of candidates) {
    const { error } = await admin.rpc("requeue_catalog_resolve", {
      p_id: c.id,
      p_fields: fields,
    });
    if (error) {
      console.error(`  ✗ ${c.id}: ${error.message}`);
      failed++;
    } else {
      console.log(`  ✓ ${c.id} (${c.isbn ?? "ta"})`);
      ok++;
    }
  }

  console.log(`\nRequeued ${ok}/${candidates.length} (${failed} failed).`);
  console.log(
    "Next catalog-replay cron run (04:00 UTC) picks the rows up automatically.",
  );
  console.log(
    'To trigger immediately: curl -H "Authorization: Bearer $CRON_SECRET" https://librito.io/api/cron/catalog-replay',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
