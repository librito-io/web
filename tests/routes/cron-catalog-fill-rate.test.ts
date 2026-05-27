// tests/routes/cron-catalog-fill-rate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: {
    CRON_SECRET: "secret",
    CATALOG_FILL_RATE_ENABLED: "true",
    COVER_STORAGE_BACKEND: "supabase",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  },
}));
vi.mock("$env/dynamic/public", () => ({
  env: { PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc" },
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
vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => supabase }));

beforeEach(() => {
  supabase._results.clear();
  // Module-scoped mock client — clear all call-recording arrays so a
  // previous test's insert/rpc doesn't leak into the next assertion.
  supabase._insertCalls.length = 0;
  supabase._rpcCalls.length = 0;
  captureMessage.mockReset();
  captureException.mockReset();
  flush.mockClear();
});

const { GET } =
  await import("../../src/routes/api/cron/catalog-fill-rate/+server");

function buildEvent(headers: Record<string, string> = {}, query: string = "") {
  const fullUrl = `http://x/api/cron/catalog-fill-rate${query}`;
  return {
    request: new Request(fullUrl, { method: "GET", headers }),
    url: new URL(fullUrl),
  } as unknown as Parameters<typeof GET>[0];
}

// Common healthy aggregate — 100 rows, 5% missing each field. Above the
// 80% alert threshold.
const HEALTHY = [
  {
    total_rows: 100,
    missing_cover: 5,
    missing_description: 5,
    missing_publisher: 10,
    missing_published_date: 10,
    missing_subjects: 10,
    missing_page_count: 10,
    desc_from_openlibrary: 40,
    desc_from_google_books: 40,
    desc_from_itunes: 10,
    desc_from_manual: 5,
  },
];

describe("GET /api/cron/catalog-fill-rate", () => {
  it("401 without bearer", async () => {
    const res = await GET(buildEvent());
    expect(res.status).toBe(401);
    expect(supabase._rpcCalls).toHaveLength(0);
  });

  it("401 on wrong CRON_SECRET", async () => {
    const res = await GET(buildEvent({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("?probe=1 short-circuits after auth without RPC + insert + Sentry", async () => {
    const res = await GET(
      buildEvent({ Authorization: "Bearer secret" }, "?probe=1"),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.probe).toBe(true);
    expect(supabase._rpcCalls).toHaveLength(0);
    expect(supabase._insertCalls).toHaveLength(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("?probe=1 without auth still returns 401 (auth before probe)", async () => {
    const res = await GET(buildEvent({}, "?probe=1"));
    expect(res.status).toBe(401);
  });

  it("returns 200 skipped=true when CATALOG_FILL_RATE_ENABLED=false", async () => {
    vi.resetModules();
    vi.doMock("$env/static/private", () => ({
      UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
      UPSTASH_REDIS_REST_TOKEN: "mock-token",
    }));
    vi.doMock("$env/dynamic/private", () => ({
      env: { CRON_SECRET: "secret", CATALOG_FILL_RATE_ENABLED: "false" },
    }));
    const { GET: G2 } =
      await import("../../src/routes/api/cron/catalog-fill-rate/+server");
    const res = await G2(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(supabase._rpcCalls).toHaveLength(0);
  });

  it("returns 500 when compute_catalog_fill_rate RPC errors", async () => {
    supabase._results.set("rpc.compute_catalog_fill_rate", {
      data: null,
      error: { message: "rpc-boom", code: "ZZ000" },
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("select_failed");
    expect(supabase._insertCalls).toHaveLength(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("returns 500 when RPC returns no rows (empty_aggregate)", async () => {
    supabase._results.set("rpc.compute_catalog_fill_rate", {
      data: [],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("empty_aggregate");
    expect(supabase._insertCalls).toHaveLength(0);
  });

  it("returns 500 when catalog_fill_rate_history insert errors", async () => {
    supabase._results.set("rpc.compute_catalog_fill_rate", {
      data: HEALTHY,
      error: null,
    });
    supabase._results.set("catalog_fill_rate_history.insert", {
      data: null,
      error: { message: "insert-boom", code: "ZZ000" },
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("insert_failed");
  });

  it("happy path: writes one snapshot row, does NOT alert when above threshold", async () => {
    supabase._results.set("rpc.compute_catalog_fill_rate", {
      data: HEALTHY,
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total_rows).toBe(100);
    expect(body.missing_cover).toBe(5);
    // One insert with the full snapshot.
    expect(supabase._insertCalls).toHaveLength(1);
    expect(supabase._insertCalls[0].table).toBe("catalog_fill_rate_history");
    expect(
      (supabase._insertCalls[0].payload as { total_rows: number }).total_rows,
    ).toBe(100);
    // Cover fill = 95/100, description fill = 95/100 — both above 0.8.
    expect(captureMessage).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("fires Sentry warning + flush when cover fill rate drops below 80%", async () => {
    supabase._results.set("rpc.compute_catalog_fill_rate", {
      data: [
        {
          ...HEALTHY[0],
          missing_cover: 25, // 75/100 = 0.75, below 0.8
        },
      ],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = captureMessage.mock.calls[0] as [
      string,
      { level: string; extra: Record<string, unknown> },
    ];
    expect(msg).toBe("catalog_fill_rate_below_threshold");
    expect(opts.level).toBe("warning");
    expect(opts.extra.coverFillRate).toBeCloseTo(0.75);
    // Flush must run before response commit so the alert survives function
    // suspension on Vercel serverless.
    expect(flush).toHaveBeenCalledWith(2000);
  });

  it("fires Sentry warning when description fill rate drops below 80%", async () => {
    supabase._results.set("rpc.compute_catalog_fill_rate", {
      data: [
        {
          ...HEALTHY[0],
          missing_description: 30, // 70/100 = 0.70
        },
      ],
      error: null,
    });
    await GET(buildEvent({ Authorization: "Bearer secret" }));
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [, opts] = captureMessage.mock.calls[0] as [
      string,
      { extra: Record<string, unknown> },
    ];
    expect(opts.extra.descriptionFillRate).toBeCloseTo(0.7);
  });

  it("skips Sentry path entirely when total_rows = 0 (avoid div-by-zero on empty catalog)", async () => {
    supabase._results.set("rpc.compute_catalog_fill_rate", {
      data: [
        {
          total_rows: 0,
          missing_cover: 0,
          missing_description: 0,
          missing_publisher: 0,
          missing_published_date: 0,
          missing_subjects: 0,
          missing_page_count: 0,
          desc_from_openlibrary: 0,
          desc_from_google_books: 0,
          desc_from_itunes: 0,
          desc_from_manual: 0,
        },
      ],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    // Snapshot still recorded.
    expect(supabase._insertCalls).toHaveLength(1);
  });
});
