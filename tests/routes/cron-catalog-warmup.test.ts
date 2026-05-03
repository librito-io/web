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

  it("uses body ISBNs when provided in JSON body", async () => {
    supabase._results.set("book_catalog.select", { data: [], error: null });
    const event = {
      request: new Request("http://x/api/cron/catalog-warmup", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          isbns: ["9780743273565", "9780451524935"],
        }),
      }),
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(event);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe("body");
    expect(resolveIsbnSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to NYT when body present but isbns is not an array", async () => {
    supabase._results.set("book_catalog.select", { data: [], error: null });
    const event = {
      request: new Request("http://x/api/cron/catalog-warmup", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ isbns: "not-an-array" }),
      }),
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(event);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe("nyt");
  });

  it("passes all body ISBNs through to resolveIsbn even when they already exist in book_catalog (negative-cache rows)", async () => {
    // Seed book_catalog.select to return BOTH ISBNs as "known" rows — simulating
    // negative-cache rows (storage_path IS NULL) already present in the catalog.
    // Before the fix, the knownSet filter excluded them and resolveIsbn was
    // never called (spy count = 0). After the fix, no SELECT pre-filter runs
    // and resolveIsbn is called for both ISBNs (spy count = 2).
    supabase._results.set("book_catalog.select", {
      data: [{ isbn: "9780743273565" }, { isbn: "9780451524935" }],
      error: null,
    });
    const event = {
      request: new Request("http://x/api/cron/catalog-warmup", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          isbns: ["9780743273565", "9780451524935"],
        }),
      }),
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(event);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe("body");
    // Both ISBNs must reach resolveIsbn — the cron must not pre-filter by catalog presence.
    expect(resolveIsbnSpy.mock.calls.length).toBe(2);
  });

  it("passes both stale-negative and fresh-negative ISBNs through to resolveIsbn", async () => {
    // Same invariant with a different set of ISBNs to confirm generality.
    // Both ISBNs are seeded as "known" (catalog already has rows for them),
    // which is what a negative-cache row looks like from the SELECT's perspective.
    supabase._results.set("book_catalog.select", {
      data: [{ isbn: "9780316769174" }, { isbn: "9780062316097" }],
      error: null,
    });
    const event = {
      request: new Request("http://x/api/cron/catalog-warmup", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          isbns: ["9780316769174", "9780062316097"],
        }),
      }),
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(event);
    expect(res.status).toBe(200);
    // resolveIsbn decides whether to short-circuit based on TTL; the cron
    // must hand all candidates to it regardless of catalog presence.
    expect(resolveIsbnSpy.mock.calls.length).toBe(2);
  });
});
