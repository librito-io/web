import { describe, it, expect, vi } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  return {
    ...actual,
    feedReadLimiter: {
      ...actual.feedReadLimiter,
      limit: vi.fn(async () => ({
        success: true,
        reset: Date.now() + 60_000,
        limit: 120,
        remaining: 119,
        pending: Promise.resolve(),
      })),
    },
  };
});

// Keep enrichment a pass-through so the allowed path doesn't reach the catalog
// subsystem (which would need its own mocks).
vi.mock("$lib/server/catalog/feed-enrichment", () => ({
  enrichFeedRowsWithCovers: vi.fn(
    async (_c: unknown, _u: string, rows: unknown[]) =>
      rows.map((r) => ({ ...(r as object), coverUrl: null })),
  ),
}));

const supabase = createMockSupabase();
const { GET } = await import("../../src/routes/app/feed/+server");

function evt(searchParams = "") {
  return {
    locals: { user: { id: "u-1" }, supabase },
    url: new URL(`http://localhost/app/feed?${searchParams}`),
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /app/feed — per-user rate limit (H6)", () => {
  it("returns 429 with Retry-After when the limiter denies", async () => {
    const rl = await import("$lib/server/ratelimit");
    (
      rl.feedReadLimiter.limit as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });

    const res = await GET(evt());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("proceeds to the RPC when the limiter allows", async () => {
    supabase._results.clear();
    // Mock keys RPC results as `rpc.<name>` (tests/helpers.ts:187).
    supabase._results.set("rpc.get_highlight_feed", { data: [], error: null });
    const res = await GET(evt("sort=recent"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});
