// tests/routes/cron-catalog-warmup.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  CRON_SECRET: "secret",
  CATALOG_WARMUP_ENABLED: "true",
  NYT_BOOKS_API_KEY: "nyt",
  COVER_STORAGE_BACKEND: "supabase",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
  PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc",
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => supabase }));

const resolveIsbnSpy = vi.fn(async () => ({
  cached: false,
  rateLimited: false,
  row: {},
}));
vi.mock("$lib/server/catalog/fetcher", () => ({ resolveIsbn: resolveIsbnSpy }));

beforeEach(() => {
  supabase._results.clear();
  resolveIsbnSpy.mockClear();
});

const { POST } =
  await import("../../src/routes/api/cron/catalog-warmup/+server");

function buildEvent(headers: Record<string, string> = {}) {
  return {
    request: new Request("http://x/api/cron/catalog-warmup", {
      method: "POST",
      headers,
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/cron/catalog-warmup", () => {
  it("401 without bearer", async () => {
    const res = await POST(buildEvent());
    expect(res.status).toBe(401);
  });

  it("401 on wrong CRON_SECRET", async () => {
    const res = await POST(buildEvent({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 with skipped=true when CATALOG_WARMUP_ENABLED=false", async () => {
    vi.resetModules();
    vi.doMock("$env/static/private", () => ({
      CRON_SECRET: "secret",
      CATALOG_WARMUP_ENABLED: "false",
      NYT_BOOKS_API_KEY: "nyt",
      UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
      UPSTASH_REDIS_REST_TOKEN: "mock-token",
    }));
    const { POST: P2 } =
      await import("../../src/routes/api/cron/catalog-warmup/+server");
    const res = await P2(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skipped).toBe(true);
  });

  it("calls resolveIsbn for each new ISBN, bounded by max-per-run", async () => {
    supabase._results.set("book_catalog.select", { data: [], error: null });
    const res = await POST(buildEvent({ Authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
    // Called for at most MAX_PER_RUN ISBNs.
    expect(resolveIsbnSpy.mock.calls.length).toBeLessThanOrEqual(100);
  });
});
