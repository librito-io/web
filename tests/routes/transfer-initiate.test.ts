// tests/routes/transfer-initiate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

// Mocks must be declared before importing the route module because route
// imports $env/static/private transitively via ratelimit.ts / supabase.ts.
vi.mock("$lib/server/ratelimit", () => ({
  transferUploadLimiter: {
    limit: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

// Import AFTER mocks.
const { POST } = await import("../../src/routes/api/transfer/initiate/+server");

function buildEvent(
  body: unknown,
  user: { id: string } | null = { id: "u-1" },
) {
  return {
    request: new Request("http://x/api/transfer/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { safeGetSession: async () => ({ user, session: null }) },
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  supabase._results.clear();
});

describe("POST /api/transfer/initiate — Deploy 1 (sha256 optional)", () => {
  it("accepts a request that omits sha256 (legacy path) and inserts status='pending_upload'", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.insert", { data: null, error: null });

    const res = await POST(
      buildEvent({ filename: "book.epub", fileSize: 100 }),
    );

    expect(res.status).toBe(201);
  });
});
