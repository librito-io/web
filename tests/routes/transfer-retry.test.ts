// tests/routes/transfer-retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

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
  beforeEach(() => {
    supabase._results.clear();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("returns 401 when no session user", async () => {
    const res = await POST(buildEvent("t-1", null));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 404 when row not found", async () => {
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
    "returns 409 not_failed when status is %s",
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
      data: null,
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

  it("returns 500 when UPDATE errors", async () => {
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
      error: { message: "down" },
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(500);
  });
});
