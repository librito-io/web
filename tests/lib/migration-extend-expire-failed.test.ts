import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const MIGRATION = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "supabase",
    "migrations",
    "20260425000001_extend_expire_failed_transfers.sql",
  ),
  "utf8",
);

describe("extend_expire_failed_transfers migration", () => {
  it("idempotently unschedules the existing expire-stale-transfers job", () => {
    expect(MIGRATION).toMatch(
      /cron\.unschedule\(jobid\)[\s\S]+jobname = 'expire-stale-transfers'/,
    );
  });

  it("reschedules expire-stale-transfers hourly", () => {
    expect(MIGRATION).toMatch(
      /cron\.schedule\([\s\S]+'expire-stale-transfers'[\s\S]+'0 \* \* \* \*'/,
    );
  });

  it("widens the WHERE clause to include 'failed' rows", () => {
    expect(MIGRATION).toMatch(/WHERE status IN \('pending', 'failed'\)/);
  });

  it("preserves the 48-hour boundary on uploaded_at", () => {
    expect(MIGRATION).toMatch(/uploaded_at < now\(\) - interval '48 hours'/);
  });
});
