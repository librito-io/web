import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../../helpers";

// Mock $env before the SUT imports any module that touches it.
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock-upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: {
    COVER_STORAGE_BACKEND: "supabase",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  },
}));
vi.mock("$env/dynamic/public", () => ({
  env: { PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc" },
}));

const { resolveIsbn } = await import("$lib/server/catalog/fetcher");

const TEST_ISBN = "9780374614911";

/**
 * Promote-on-resolve guards the data-layer fix for issue #427: when a
 * book first synced ISBN-less has a TA-keyed catalog row and a later
 * sync populates books.isbn, the resolver promotes the TA row to
 * ISBN-keyed instead of creating a duplicate. These cases assert the
 * three branches:
 *   - existing ISBN-row missing + ctx supplied + promote=true  → recurse + cached
 *   - existing ISBN-row missing + ctx supplied + promote=false → fall through
 *   - existing ISBN-row missing + ctx absent                   → no RPC call
 */
describe("resolveIsbn promote-on-resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls promote_ta_to_isbn when no ISBN row exists and ctx supplied; recurses on success", async () => {
    const supabase = createMockSupabase();
    // Two SELECTs on book_catalog hit selectByIsbn: first returns null
    // (no ISBN row yet), second (post-promote, after recurse) returns the
    // promoted row fully populated so the cache short-circuit fires.
    supabase._resultsQueue.set("book_catalog.select", [
      { data: null, error: null },
      {
        data: {
          isbn: TEST_ISBN,
          pending_storage: false,
          storage_path: "ab/abc.jpg",
          cover_storage_backend: "supabase",
          description: "fully populated",
          publisher: "A Press",
          published_date: "2020",
          subjects: ["fiction"],
          page_count: 200,
        },
        error: null,
      },
    ]);
    supabase._results.set("rpc.promote_ta_to_isbn", {
      data: true,
      error: null,
    });

    const r = await resolveIsbn(
      supabase as never,
      TEST_ISBN,
      buildMinimalDeps(),
      { title: "Ruth", author: "Kate Riley" },
    );

    const promoteCalls = supabase._rpcCalls.filter(
      (c) => c.name === "promote_ta_to_isbn",
    );
    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0].args).toEqual({
      p_isbn: TEST_ISBN,
      p_ta_key: "ruth|kate riley",
    });
    expect(r.cached).toBe(true);
    expect(r.rateLimited).toBe(false);
  });

  it("falls through to cold-resolve when promote returns false", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: null, error: null });
    supabase._results.set("rpc.promote_ta_to_isbn", {
      data: false,
      error: null,
    });

    const r = await resolveIsbn(
      supabase as never,
      TEST_ISBN,
      buildMinimalDeps({ mutexAcquired: false }),
      { title: "Nothing", author: "Matches" },
    );

    // RPC was attempted exactly once (the false return means no recurse).
    const promoteCalls = supabase._rpcCalls.filter(
      (c) => c.name === "promote_ta_to_isbn",
    );
    expect(promoteCalls).toHaveLength(1);
    // Cold-resolve continued past promote; mutex denied so short-circuit
    // with rateLimited=true. The point is the resolver did NOT throw and
    // did NOT return cached=true (no cache hit on an empty row).
    expect(r.cached).toBe(false);
    expect(r.rateLimited).toBe(true);
  });

  it("does not call promote when ctx is omitted", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: null, error: null });

    await resolveIsbn(
      supabase as never,
      TEST_ISBN,
      buildMinimalDeps({ mutexAcquired: false }),
    );

    const promoteCalls = supabase._rpcCalls.filter(
      (c) => c.name === "promote_ta_to_isbn",
    );
    expect(promoteCalls).toHaveLength(0);
  });

  it("does not call promote when ctx is supplied but title or author is blank", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: null, error: null });

    await resolveIsbn(
      supabase as never,
      TEST_ISBN,
      buildMinimalDeps({ mutexAcquired: false }),
      { title: "Only Title" }, // no author
    );

    const promoteCalls = supabase._rpcCalls.filter(
      (c) => c.name === "promote_ta_to_isbn",
    );
    expect(promoteCalls).toHaveLength(0);
  });
});

interface MinimalDepsOpts {
  mutexAcquired?: boolean;
}

function buildMinimalDeps(opts: MinimalDepsOpts = {}) {
  const acquired = opts.mutexAcquired ?? false;
  return {
    rateLimiters: {
      openLibrary: { limit: async () => ({ success: true }) },
      googleBooks: { limit: async () => ({ success: true }) },
      itunes: { limit: async () => ({ success: true }) },
    },
    mutex: {
      acquire: async () => acquired,
      release: async () => {},
    },
    fetchFn: async () => new Response("{}"),
    googleBooksApiKey: undefined,
  } as never;
}
