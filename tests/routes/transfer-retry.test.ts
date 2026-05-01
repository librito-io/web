// tests/routes/transfer-retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$lib/server/ratelimit", async () => {
  const { passThroughLegacySafeLimit } = await import("../helpers");
  return {
    transferRetryLimiter: {
      limit: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
    },
    legacySafeLimit: passThroughLegacySafeLimit,
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } =
  await import("../../src/routes/api/transfer/[id]/retry/+server");

function buildEvent(
  transferId: string,
  user: { id: string } | null = { id: "u-1" },
) {
  return {
    request: new Request(`http://x/api/transfer/${transferId}/retry`, {
      method: "POST",
    }),
    params: { id: transferId },
    locals: { safeGetSession: async () => ({ user, session: null }) },
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/transfer/[id]/retry", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    supabase._results.clear();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("returns 401 when no session user", async () => {
    const res = await POST(buildEvent("t-1", null));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 429 when rate-limited", async () => {
    const rl = await import("$lib/server/ratelimit");
    (
      rl.transferRetryLimiter.limit as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("returns 404 when row not found (also masks scrubbed rows via .is(scrubbed_at, null))", async () => {
    supabase._results.set("book_transfers.select", {
      data: null,
      error: null,
    });
    const res = await POST(buildEvent("t-missing"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 404 when transfer.user_id !== session.user.id", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "other",
        status: "failed",
        attempt_count: 10,
        last_error: "x",
      },
      error: null,
    });
    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(404);
  });

  it.each(["pending", "downloaded", "expired"] as const)(
    "returns 409 not_failed when status is %s and emits transfer.retry_invalid_status warn",
    async (status) => {
      supabase._results.set("book_transfers.select", {
        data: {
          id: "t-1",
          user_id: "u-1",
          status,
          attempt_count: 0,
          last_error: null,
        },
        error: null,
      });
      const res = await POST(buildEvent("t-1"));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("not_failed");

      const call = warnSpy.mock.calls.find(
        (c) => c[0] === "transfer.retry_invalid_status",
      );
      expect(call).toBeDefined();
    },
  );

  it("on failed row: UPDATE resets fields, returns 200, emits transfer.retry_reset (info)", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "failed",
        attempt_count: 10,
        last_error: "Couldn't deliver to your device after 10 attempts.",
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: "t-1" }],
      error: null,
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const call = infoSpy.mock.calls.find(
      (c) => c[0] === "transfer.retry_reset",
    );
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      transferId: "t-1",
      userId: "u-1",
      previousAttemptCount: 10,
      previousLastError: "Couldn't deliver to your device after 10 attempts.",
    });
  });

  it("on UPDATE returning zero rows (TOCTOU race): returns 409 retry_race and warns", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "failed",
        attempt_count: 10,
        last_error: "x",
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", { data: [], error: null });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("retry_race");

    const call = warnSpy.mock.calls.find((c) => c[0] === "transfer.retry_race");
    expect(call).toBeDefined();

    const reset = infoSpy.mock.calls.find(
      (c) => c[0] === "transfer.retry_reset",
    );
    expect(reset).toBeUndefined();
  });

  it("maps Postgres 23505 on UPDATE to 409 duplicate_pending_transfer", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "failed",
        attempt_count: 10,
        last_error: "x",
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("duplicate_pending_transfer");
  });

  it("returns 500 when UPDATE errors with non-23505 code", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "failed",
        attempt_count: 10,
        last_error: "x",
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: null,
      error: { message: "down", code: "08006" },
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(500);
  });
});
