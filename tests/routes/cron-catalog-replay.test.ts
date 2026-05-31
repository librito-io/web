// tests/routes/cron-catalog-replay.test.ts
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
    CATALOG_REPLAY_ENABLED: "true",
    COVER_STORAGE_BACKEND: "supabase",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  },
}));
vi.mock("$env/dynamic/public", () => ({
  env: { PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc" },
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => supabase }));

// Capture the work items + opts handed to scheduleCatalogResolveIfAllowed.
const scheduleSpy = vi.fn(
  async (
    _userId: string,
    _work: unknown[],
    _opts?: { bypassUserLimit?: boolean },
  ): Promise<void> => undefined,
);
vi.mock("$lib/server/catalog/scheduling", () => ({
  scheduleCatalogResolveIfAllowed: scheduleSpy,
}));

beforeEach(() => {
  supabase._results.clear();
  supabase._rpcCalls.length = 0;
  scheduleSpy.mockClear();
});

const { GET } =
  await import("../../src/routes/api/cron/catalog-replay/+server");

function buildEvent(headers: Record<string, string> = {}, query: string = "") {
  const fullUrl = `http://x/api/cron/catalog-replay${query}`;
  return {
    request: new Request(fullUrl, { method: "GET", headers }),
    url: new URL(fullUrl),
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /api/cron/catalog-replay", () => {
  it("401 without bearer", async () => {
    const res = await GET(buildEvent());
    expect(res.status).toBe(401);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("401 on wrong CRON_SECRET", async () => {
    const res = await GET(buildEvent({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("?probe=1 short-circuits after auth without calling RPC or scheduling", async () => {
    const res = await GET(
      buildEvent({ Authorization: "Bearer secret" }, "?probe=1"),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.probe).toBe(true);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("?probe=1 without auth still returns 401 (auth before probe)", async () => {
    const res = await GET(buildEvent({}, "?probe=1"));
    expect(res.status).toBe(401);
  });

  it("returns 200 skipped=true when CATALOG_REPLAY_ENABLED=false", async () => {
    vi.resetModules();
    vi.doMock("$env/static/private", () => ({
      UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
      UPSTASH_REDIS_REST_TOKEN: "mock-token",
    }));
    vi.doMock("$env/dynamic/private", () => ({
      env: { CRON_SECRET: "secret", CATALOG_REPLAY_ENABLED: "false" },
    }));
    const { GET: G2 } =
      await import("../../src/routes/api/cron/catalog-replay/+server");
    const res = await G2(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("returns 200 replayed=0 when RPC returns empty list", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: [],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.replayed).toBe(0);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("returns 500 when RPC errors", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: null,
      error: { message: "boom", code: "ZZ000" },
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("select_failed");
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("maps ISBN-bearing rows into kind=isbn work with ctx + fields", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: [
        {
          id: "uuid-1",
          isbn: "9780000000010",
          normalized_title_author: null,
          title: "Some Title",
          author: "Some Author",
          replay_fields: ["description", "cover"],
        },
      ],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    const [userId, work, opts] = scheduleSpy.mock.calls[0] as [
      string,
      unknown[],
      { bypassUserLimit?: boolean },
    ];
    expect(userId).toBe("00000000-c47a-1090-0000-7e7c91ce17a0");
    expect(opts).toEqual({ bypassUserLimit: true });
    expect(work).toEqual([
      {
        kind: "isbn",
        isbn: "9780000000010",
        ctx: { title: "Some Title", author: "Some Author" },
        fields: ["description", "cover"],
      },
    ]);
  });

  it("maps ISBN row with no title/author into kind=isbn work with ctx=undefined", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: [
        {
          id: "uuid-2",
          isbn: "9780000000011",
          normalized_title_author: null,
          title: null,
          author: null,
          replay_fields: ["description"],
        },
      ],
      error: null,
    });
    await GET(buildEvent({ Authorization: "Bearer secret" }));
    const [, work] = scheduleSpy.mock.calls[0] as [string, unknown[], unknown];
    expect(work).toEqual([
      {
        kind: "isbn",
        isbn: "9780000000011",
        ctx: undefined,
        fields: ["description"],
      },
    ]);
  });

  it("maps ISBN-less row with title+author into kind=ta work, threading the stored key (#489 Fix A)", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: [
        {
          id: "uuid-3",
          isbn: null,
          normalized_title_author: "ruth|kate-riley",
          title: "Ruth",
          author: "Kate Riley",
          replay_fields: ["publisher"],
        },
      ],
      error: null,
    });
    await GET(buildEvent({ Authorization: "Bearer secret" }));
    const [, work] = scheduleSpy.mock.calls[0] as [string, unknown[], unknown];
    // The cron knows the row's stored key; it must pass it so a drifted row
    // re-resolves in place instead of forking (the cron is the second caller
    // with the same bug as admin requeue).
    expect(work).toEqual([
      {
        kind: "ta",
        title: "Ruth",
        author: "Kate Riley",
        fields: ["publisher"],
        normalizedTitleAuthor: "ruth|kate-riley",
      },
    ]);
  });

  it("drops rows with empty replay_fields", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: [
        {
          id: "uuid-4",
          isbn: "9780000000012",
          normalized_title_author: null,
          title: "T",
          author: "A",
          replay_fields: [],
        },
        {
          id: "uuid-5",
          isbn: "9780000000013",
          normalized_title_author: null,
          title: "T2",
          author: "A2",
          replay_fields: ["description"],
        },
      ],
      error: null,
    });
    await GET(buildEvent({ Authorization: "Bearer secret" }));
    const [, work] = scheduleSpy.mock.calls[0] as [string, unknown[], unknown];
    expect(work).toHaveLength(1);
    expect((work[0] as { isbn: string }).isbn).toBe("9780000000013");
  });

  it("filters non-TrackedField values out of replay_fields (DB drift defense)", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: [
        {
          id: "uuid-6",
          isbn: "9780000000014",
          normalized_title_author: null,
          title: "T",
          author: "A",
          // Simulate an unknown future field name leaking through the RPC.
          replay_fields: ["description", "bogus", "cover"],
        },
      ],
      error: null,
    });
    await GET(buildEvent({ Authorization: "Bearer secret" }));
    const [, work] = scheduleSpy.mock.calls[0] as [string, unknown[], unknown];
    expect((work[0] as { fields: string[] }).fields).toEqual([
      "description",
      "cover",
    ]);
  });

  it("drops ISBN-less + title-less rows entirely (can't schedule either kind)", async () => {
    supabase._results.set("rpc.select_replay_candidates", {
      data: [
        {
          id: "uuid-7",
          isbn: null,
          normalized_title_author: "bad",
          title: null,
          author: null,
          replay_fields: ["description"],
        },
      ],
      error: null,
    });
    const res = await GET(buildEvent({ Authorization: "Bearer secret" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // scheduleSpy still called (with empty work) — handler decides whether
    // to short-circuit. Either: not called OR called with empty work.
    if (scheduleSpy.mock.calls.length > 0) {
      const [, work] = scheduleSpy.mock.calls[0] as [
        string,
        unknown[],
        unknown,
      ];
      expect(work).toEqual([]);
    }
    expect(body.scheduled).toBe(0);
  });
});
