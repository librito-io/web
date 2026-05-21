import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getAdmin, getAnon, getSql, shutdown } from "./helpers";

// Behavior-level guard for the SECURITY DEFINER function powering the
// pg-cron-health cron. Seeds rows into cron.job_run_details and verifies:
//   1. The function returns one row per failing job with correct count.
//   2. Successes are excluded.
//   3. Rows older than 7 days are excluded.
//   4. service_role can call the function via supabase-js .rpc().
//   5. anon and authenticated have no EXECUTE grant (via ACL inspection),
//      and PostgREST denies anon at the HTTP boundary.
//
// Why ACL inspection instead of `SET LOCAL ROLE anon; SELECT ...`: the
// local Supabase Postgres 17.6 Docker image segfaults on any permission-
// denied function call from anon. Reproducible with a trivial non-
// SECURITY-DEFINER function. The segfault is in the error-handling path,
// not in the privilege system; has_function_privilege() returning false
// is the load-bearing assertion. The supabase-js anon .rpc() check
// covers the actual HTTP boundary anon hits in production.
//
// Why cron.schedule() / cron.unschedule() instead of direct INSERT into
// cron.job: cron.job is owned by supabase_admin; the postgres role
// connecting via DB_URL has SELECT only. cron.schedule() is the supported
// API and runs with extension owner privileges. For cron.job_run_details
// rows we INSERT directly (postgres has full grants) but generate runid
// via Math.random() because cron.runid_seq has no grants and postgres
// cannot call nextval('cron.runid_seq').

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)("pg_cron_failure_summary", () => {
  const sql = getSql();
  const seededJobNames = new Set<string>();

  async function cleanup(): Promise<void> {
    for (const name of seededJobNames) {
      try {
        await sql`SELECT cron.unschedule(${name})`;
      } catch {
        // Already unscheduled or never existed — ignore.
      }
    }
    seededJobNames.clear();
    // RLS on cron.job_run_details filters by username = CURRENT_USER, so
    // this DELETE only sees rows we inserted (username = 'postgres'). Real
    // pg_cron-fired runs from supabase_admin remain invisible to us, which
    // is the correct isolation.
    await sql`
      DELETE FROM cron.job_run_details
      WHERE command = 'SELECT 1 -- it-pg-cron-health'
    `;
  }

  afterAll(async () => {
    await cleanup();
    await shutdown();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function seedJob(jobname: string): Promise<number> {
    const [row] = await sql<{ jobid: number }[]>`
      SELECT cron.schedule(${jobname}, '* * * * *', 'SELECT 1') AS jobid
    `;
    seededJobNames.add(jobname);
    return row.jobid;
  }

  // Random 53-bit safe-int runid. Collision risk is effectively zero on a
  // freshly reset test DB; if it ever happens the PK constraint surfaces
  // a loud error rather than silent data corruption.
  function randomRunid(): number {
    return Math.floor(Math.random() * 2 ** 52);
  }

  async function seedRun(
    jobid: number,
    status: "succeeded" | "failed",
    startTime: Date,
  ): Promise<void> {
    await sql`
      INSERT INTO cron.job_run_details
        (jobid, runid, job_pid, database, username, command, status,
         return_message, start_time, end_time)
      VALUES (${jobid}, ${randomRunid()}, 0, 'postgres', 'postgres',
              'SELECT 1 -- it-pg-cron-health',
              ${status}, '', ${startTime.toISOString()},
              ${startTime.toISOString()})
    `;
  }

  it("returns rows only for jobs with failures in the last 7 days", async () => {
    const jid1 = await seedJob("it-pg-cron-health-fails");
    const jid2 = await seedJob("it-pg-cron-health-clean");
    const recent = new Date(Date.now() - 60_000);
    await seedRun(jid1, "failed", recent);
    await seedRun(jid1, "failed", recent);
    await seedRun(jid1, "succeeded", recent);
    await seedRun(jid2, "succeeded", recent);

    const { data, error } = await getAdmin().rpc(
      "pg_cron_failure_summary" as never,
    );
    expect(error).toBeNull();
    const rows = data as Array<{ jobname: string; failures: number }>;
    const fails = rows.find((r) => r.jobname === "it-pg-cron-health-fails");
    const clean = rows.find((r) => r.jobname === "it-pg-cron-health-clean");
    expect(fails).toEqual({ jobname: "it-pg-cron-health-fails", failures: 2 });
    expect(clean).toBeUndefined();
  });

  it("excludes failed rows older than 7 days", async () => {
    const jid = await seedJob("it-pg-cron-health-old");
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await seedRun(jid, "failed", old);

    const { data, error } = await getAdmin().rpc(
      "pg_cron_failure_summary" as never,
    );
    expect(error).toBeNull();
    const rows = data as Array<{ jobname: string; failures: number }>;
    expect(
      rows.find((r) => r.jobname === "it-pg-cron-health-old"),
    ).toBeUndefined();
  });

  it("denies EXECUTE to anon and authenticated (REVOKE FROM PUBLIC + anon/authenticated)", async () => {
    const [anonRow] = await sql<{ has: boolean }[]>`
      SELECT has_function_privilege(
        'anon',
        'public.pg_cron_failure_summary()',
        'EXECUTE'
      ) AS has
    `;
    expect(anonRow.has).toBe(false);

    const [authRow] = await sql<{ has: boolean }[]>`
      SELECT has_function_privilege(
        'authenticated',
        'public.pg_cron_failure_summary()',
        'EXECUTE'
      ) AS has
    `;
    expect(authRow.has).toBe(false);

    const [serviceRow] = await sql<{ has: boolean }[]>`
      SELECT has_function_privilege(
        'service_role',
        'public.pg_cron_failure_summary()',
        'EXECUTE'
      ) AS has
    `;
    expect(serviceRow.has).toBe(true);
  });

  it("PostgREST denies anon at the HTTP boundary", async () => {
    // Production path: anon hits /rest/v1/rpc/pg_cron_failure_summary.
    // PostgREST should reject before the SQL layer runs. The exact error
    // shape varies (401/403, code may be PGRST*); assert presence, not
    // exact match.
    const { data, error } = await getAnon().rpc(
      "pg_cron_failure_summary" as never,
    );
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});
