import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/dynamic/private", () => ({
  env: { CRON_SECRET: "test-secret" },
}));

const captureMessage = vi.fn();
const captureException = vi.fn();
const flush = vi.fn(async () => true);
vi.mock("@sentry/sveltekit", () => ({
  captureMessage,
  captureException,
  flush,
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { GET } =
  await import("../../src/routes/api/cron/pg-cron-health/+server");

function buildEvent(headers: Record<string, string> = {}, query: string = "") {
  const fullUrl = `http://x/api/cron/pg-cron-health${query}`;
  return {
    request: new Request(fullUrl, { method: "GET", headers }),
    url: new URL(fullUrl),
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  supabase._results.clear();
  captureMessage.mockReset();
  captureException.mockReset();
  flush.mockClear();
});

describe("GET /api/cron/pg-cron-health", () => {
  it("returns 401 when Authorization header missing", async () => {
    const res = await GET(buildEvent());
    expect(res.status).toBe(401);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("returns 401 on wrong CRON_SECRET", async () => {
    const res = await GET(buildEvent({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("?probe=1 short-circuits after auth without RPC call", async () => {
    const res = await GET(
      buildEvent({ Authorization: "Bearer test-secret" }, "?probe=1"),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.probe).toBe(true);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(supabase._rpcCalls).toHaveLength(0);
  });

  it("?probe=1 without auth still returns 401", async () => {
    const res = await GET(buildEvent({}, "?probe=1"));
    expect(res.status).toBe(401);
  });

  it("does NOT captureMessage when no failures present", async () => {
    supabase._results.set("rpc.pg_cron_failure_summary", {
      data: [],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.failures).toEqual([]);
    expect(body.jobsChecked).toBe(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("captureMessage fires when failures > 0 with source tag and extra", async () => {
    supabase._results.set("rpc.pg_cron_failure_summary", {
      data: [
        { jobname: "expire-stale-transfers", failures: 3 },
        { jobname: "empty-trashed-notes", failures: 1 },
      ],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.failures).toHaveLength(2);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      "pg_cron_failures_detected",
      expect.objectContaining({
        level: "error",
        tags: { source: "pg_cron_health" },
        extra: expect.objectContaining({
          failures: expect.any(Array),
          windowDays: 7,
        }),
      }),
    );
  });

  it("filters rows with failures == 0 out before captureMessage", async () => {
    supabase._results.set("rpc.pg_cron_failure_summary", {
      data: [
        { jobname: "expire-stale-transfers", failures: 0 },
        { jobname: "empty-trashed-notes", failures: 0 },
      ],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.failures).toEqual([]);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  // Issue #358: Sentry.flush(2000) before return on every path that emitted
  // an event, so the SDK's async transport completes the send before Vercel
  // serverless suspends the function.
  it("awaits Sentry.flush(2000) when captureMessage fires", async () => {
    supabase._results.set("rpc.pg_cron_failure_summary", {
      data: [{ jobname: "expire-stale-transfers", failures: 3 }],
      error: null,
    });
    await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    expect(flush).toHaveBeenCalledWith(2000);
  });

  it("does NOT call Sentry.flush on the clean (no-failures) path", async () => {
    supabase._results.set("rpc.pg_cron_failure_summary", {
      data: [{ jobname: "expire-stale-transfers", failures: 0 }],
      error: null,
    });
    await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    expect(flush).not.toHaveBeenCalled();
  });

  it("captureException fires + 500 returned on RPC error", async () => {
    supabase._results.set("rpc.pg_cron_failure_summary", {
      data: null,
      error: { message: "permission denied" },
    });
    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledWith(2000);
  });
});
