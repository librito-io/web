// tests/routes/transfer-list.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  return {
    ...actual,
    transferListLimiter: {
      ...actual.transferListLimiter,
      limit: vi.fn(async () => ({
        success: true,
        reset: Date.now() + 60_000,
        limit: 60,
        remaining: 59,
        pending: Promise.resolve(),
      })),
    },
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { GET } = await import("../../src/routes/api/transfer/list/+server");

beforeEach(() => {
  supabase._results.clear();
  supabase._chainCalls.length = 0;
});

describe("GET /api/transfer/list — WS-D projection", () => {
  it("returns attemptCount, lastError, lastAttemptAt for each transfer", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "t-1",
          filename: "a.epub",
          file_size: 100,
          status: "failed",
          uploaded_at: "2026-04-25T00:00:00Z",
          downloaded_at: null,
          attempt_count: 10,
          last_error: "Couldn't deliver to your device after 10 attempts.",
          last_attempt_at: "2026-04-25T01:23:45Z",
        },
      ],
      error: null,
    });

    const evt = {
      locals: {
        safeGetSession: async () => ({
          user: { id: "u-1" },
          session: null,
        }),
      },
    } as unknown as Parameters<typeof GET>[0];
    const res = await GET(evt);
    const body = await res.json();

    expect(body.transfers[0]).toMatchObject({
      attemptCount: 10,
      lastError: "Couldn't deliver to your device after 10 attempts.",
      lastAttemptAt: "2026-04-25T01:23:45Z",
    });
  });

  it("applies .is('scrubbed_at', null) and .limit(100) to bound payload", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });

    const evt = {
      locals: {
        safeGetSession: async () => ({ user: { id: "u-1" }, session: null }),
      },
    } as unknown as Parameters<typeof GET>[0];
    await GET(evt);

    const selectChainCalls = supabase._chainCalls.filter(
      (c) => c.table === "book_transfers" && c.operation === "select",
    );
    const scrubbedFilter = selectChainCalls.find(
      (c) =>
        c.method === "is" && c.args[0] === "scrubbed_at" && c.args[1] === null,
    );
    const limitCall = selectChainCalls.find(
      (c) => c.method === "limit" && c.args[0] === 100,
    );
    expect(scrubbedFilter).toBeDefined();
    expect(limitCall).toBeDefined();
  });

  it("returns 429 with Retry-After header when rate-limited", async () => {
    const rl = await import("$lib/server/ratelimit");
    (
      rl.transferListLimiter.limit as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });

    const evt = {
      locals: {
        safeGetSession: async () => ({ user: { id: "u-1" }, session: null }),
      },
    } as unknown as Parameters<typeof GET>[0];
    const res = await GET(evt);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });
});
