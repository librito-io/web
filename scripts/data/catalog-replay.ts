#!/usr/bin/env -S npx tsx
//
// Operator CLI for catalog row requeue. Wraps requeue_catalog_resolve(id,
// fields[]) via service-role Supabase. Print-only — the next nightly
// catalog-replay cron picks the requeued rows up; the CLI does NOT
// trigger the cron itself. The README + final log line shows the curl
// recipe to force-fire it.
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
import {
  TRACKED_FIELDS,
  parseFieldsArg,
  pickPredicateMode,
  missingFieldColumn,
  failReasonOrClause,
} from "./catalog-replay-predicates";

const BULK_MODE_LIMIT = 500;

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
  const fields = parseFieldsArg(values.fields);

  const mode = pickPredicateMode({
    isbns: values.isbns,
    missing: values.missing,
    byFailReason: values["by-fail-reason"],
  });

  const admin = createClient(url, key, { auth: { persistSession: false } });

  type Candidate = {
    id: string;
    isbn: string | null;
    title: string | null;
    author: string | null;
  };
  let candidates: Candidate[];

  if (mode.kind === "isbns") {
    const { data, error } = await admin
      .from("book_catalog")
      .select("id, isbn, title, author")
      .in("isbn", mode.isbns);
    if (error) throw new Error(error.message);
    candidates = (data ?? []) as Candidate[];
  } else if (mode.kind === "missing") {
    const col = missingFieldColumn(mode.field);
    const { data, error } = await admin
      .from("book_catalog")
      .select("id, isbn, title, author")
      .is(col, null)
      .limit(BULK_MODE_LIMIT);
    if (error) throw new Error(error.message);
    candidates = (data ?? []) as Candidate[];
  } else {
    const orClause = failReasonOrClause(mode.reason);
    const { data, error } = await admin
      .from("book_catalog")
      .select("id, isbn, title, author")
      .or(orClause)
      .limit(BULK_MODE_LIMIT);
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
