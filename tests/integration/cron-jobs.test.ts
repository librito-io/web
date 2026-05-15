import { afterAll, describe, expect, it } from "vitest";
import { getSql, shutdown } from "./helpers";

// Verifies pg_cron jobs scheduled by migrations are present after
// `supabase db reset`. Guards against a future migration that drops or
// renames a job without scheduling its replacement.
//
// `command` content is asserted via the existing string-match unit tests;
// here we only assert presence + canonical schedule. Coupling to the schedule
// string is intentional: a migration that re-schedules at a different cadence
// without updating the unit test would slip through, but updating both is the
// expected workflow.

const SKIP = !process.env.INTEGRATION;

interface CronJob {
  jobname: string;
  schedule: string;
}

const EXPECTED: ReadonlyArray<CronJob> = [
  { jobname: "empty-trashed-notes", schedule: "0 3 * * *" },
  { jobname: "expire-pairing-codes", schedule: "*/5 * * * *" },
  { jobname: "expire-stale-transfers", schedule: "0 * * * *" },
  { jobname: "scrub-retired-transfers", schedule: "0 * * * *" },
];

describe.skipIf(SKIP)("pg_cron scheduled jobs", () => {
  const sql = getSql();

  afterAll(async () => {
    await shutdown();
  });

  it("registers all expected jobs with their canonical schedules", async () => {
    const rows = await sql<CronJob[]>`
      SELECT jobname, schedule
        FROM cron.job
       WHERE jobname IN ${sql(EXPECTED.map((j) => j.jobname))}
       ORDER BY jobname
    `;
    expect(rows).toEqual(
      [...EXPECTED].sort((a, b) => a.jobname.localeCompare(b.jobname)),
    );
  });

  it("schedules empty-trashed-notes (acceptance criterion for #101)", async () => {
    const [row] = await sql<CronJob[]>`
      SELECT jobname, schedule
        FROM cron.job
       WHERE jobname = 'empty-trashed-notes'
    `;
    expect(row).toBeDefined();
    expect(row.schedule).toBe("0 3 * * *");
  });
});
