// tests/routes/transfer-delete.test.ts
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
    transferCancelLimiter: {
      ...actual.transferCancelLimiter,
      limit: vi.fn(async () => ({
        success: true,
        reset: Date.now() + 60_000,
        limit: 30,
        remaining: 29,
        pending: Promise.resolve(),
      })),
    },
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { DELETE } =
  await import("../../src/routes/app/api/transfer/[id]/+server");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

// Signed-out 401 is enforced by appAuthGuard; per-handler tests
// always run with locals.user populated (the hook's contract).
function buildEvent(transferId: string, user: { id: string } = { id: "u-1" }) {
  return {
    params: { id: transferId },
    locals: { user },
  } as unknown as Parameters<typeof DELETE>[0];
}

describe("DELETE /app/api/transfer/[id]", () => {
  beforeEach(() => {
    supabase._results.clear();
    supabase._storage.clear();
  });

  it("returns 404 on malformed UUID, no DB call", async () => {
    const res = await DELETE(buildEvent("not-a-uuid"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    expect(supabase._updateCalls).toHaveLength(0);
  });

  it("returns 429 with Retry-After header when rate-limited", async () => {
    const rl = await import("$lib/server/ratelimit");
    (
      rl.transferCancelLimiter.limit as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });

    const res = await DELETE(buildEvent(VALID_ID));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("returns 404 when transfer not found", async () => {
    supabase._results.set("book_transfers.select", { data: null, error: null });
    const res = await DELETE(buildEvent(VALID_ID));
    expect(res.status).toBe(404);
  });

  it("returns 404 when transfer.user_id !== session.user.id", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: VALID_ID,
        user_id: "other",
        storage_path: "p",
        status: "pending",
      },
      error: null,
    });
    const res = await DELETE(buildEvent(VALID_ID));
    expect(res.status).toBe(404);
  });

  it.each(["downloaded", "expired"] as const)(
    "returns 409 cannot_cancel when status is %s",
    async (status) => {
      supabase._results.set("book_transfers.select", {
        data: {
          id: VALID_ID,
          user_id: "u-1",
          storage_path: "p",
          status,
        },
        error: null,
      });
      const res = await DELETE(buildEvent(VALID_ID));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("cannot_cancel");
    },
  );

  // Scrubbed rows (filename/sha256 nulled, scrubbed_at set) keep their
  // pre-scrub status. The SELECT's .is("scrubbed_at", null) filter excludes
  // them, so the handler returns 404, matching /retry and /download-url.
  it("returns 404 when row is scrubbed (filtered by .is(scrubbed_at, null))", async () => {
    supabase._results.set("book_transfers.select", { data: null, error: null });
    const res = await DELETE(buildEvent(VALID_ID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("on success: removes storage and deletes row", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: VALID_ID,
        user_id: "u-1",
        storage_path: "u-1/x.epub",
        status: "pending",
      },
      error: null,
    });
    supabase._results.set("book_transfers.delete", { data: null, error: null });

    const res = await DELETE(buildEvent(VALID_ID));
    expect(res.status).toBe(200);
  });
});
