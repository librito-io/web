// tests/routes/transfer-confirm.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$lib/server/auth", () => ({
  authenticateDevice: vi.fn(async () => ({
    device: { id: "d-1", userId: "u-1" },
  })),
}));

vi.mock("$lib/server/ratelimit", () => ({
  transferConfirmLimiter: {
    limit: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } =
  await import("../../src/routes/api/transfer/[id]/confirm/+server");

function buildEvent(transferId: string) {
  return {
    request: new Request(`http://x/api/transfer/${transferId}/confirm`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_device_xxx" },
    }),
    params: { id: transferId },
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/transfer/[id]/confirm — WS-D", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    supabase._results.clear();
    supabase._storage.clear();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("on success: writes status='downloaded', resets accounting fields, emits transfer.confirm_success", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "pending",
        storage_path: "u-1/t-1/book.epub",
        attempt_count: 3,
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: "t-1" }],
      error: null,
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(200);

    const call = infoSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_success",
    );
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      transferId: "t-1",
      userId: "u-1",
      deviceId: "d-1",
      attemptCountAtSuccess: 3,
    });
  });

  it("on update returning zero rows (TOCTOU race): emits transfer.confirm_race, returns 409, does not delete storage or log success", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "pending",
        storage_path: "u-1/t-1/book.epub",
        attempt_count: 3,
      },
      error: null,
    });
    // Guarded UPDATE matches zero rows (row already moved out of pending).
    supabase._results.set("book_transfers.update", { data: [], error: null });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(409);

    const successCall = infoSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_success",
    );
    expect(successCall).toBeUndefined();

    const raceCall = warnSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_race",
    );
    expect(raceCall).toBeDefined();

    // No storage.remove on a row that did not transition.
    const removeCall = supabase._storage.get("remove");
    expect(removeCall).toBeUndefined();
  });

  it("on update error pre-cap: calls increment_transfer_attempt RPC, emits transfer.confirm_failure (warn) using RPC-returned count", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "pending",
        storage_path: "u-1/t-1/book.epub",
        attempt_count: 4,
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: null,
      error: { message: "boom", code: "08006" },
    });
    supabase._results.set("rpc.increment_transfer_attempt", {
      data: [{ attempt_count: 5, status: "pending" }],
      error: null,
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(500);

    const call = warnSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_failure",
    );
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload.transferId).toBe("t-1");
    expect(payload.userId).toBe("u-1");
    expect(payload.deviceId).toBe("d-1");
    expect(payload.newAttemptCount).toBe(5);
    expect(payload.error).toBe("boom");
    expect(payload.errorCode).toBe("08006");
  });

  it("on update error at cap: RPC returns status='failed', handler emits transfer.cap_hit_failed (error) with attemptCount=10", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "pending",
        storage_path: "u-1/t-1/book.epub",
        attempt_count: 9,
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: null,
      error: { message: "transport reset", code: "08006" },
    });
    supabase._results.set("rpc.increment_transfer_attempt", {
      data: [{ attempt_count: 10, status: "failed" }],
      error: null,
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(500);

    const call = errorSpy.mock.calls.find(
      (c) => c[0] === "transfer.cap_hit_failed",
    );
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload.attemptCount).toBe(10);
    expect(payload.transferId).toBe("t-1");
    expect(payload.userId).toBe("u-1");
    expect(payload.deviceId).toBe("d-1");
    expect(payload.error).toBe("transport reset");
    expect(payload.errorCode).toBe("08006");

    const warn = warnSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_failure",
    );
    expect(warn).toBeUndefined();
  });

  it("on update error + RPC matches zero rows (race after updateError): emits transfer.confirm_failure_no_change, no numeric attempt log", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "pending",
        storage_path: "u-1/t-1/book.epub",
        attempt_count: 4,
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: null,
      error: { message: "deadlock", code: "40P01" },
    });
    // RPC ran without error but matched zero rows — row already moved out of
    // pending between the UPDATE error and the RPC's WHERE status='pending'.
    supabase._results.set("rpc.increment_transfer_attempt", {
      data: [],
      error: null,
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(500);

    const noChange = warnSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_failure_no_change",
    );
    expect(noChange).toBeDefined();
    const payload = noChange![1] as Record<string, unknown>;
    expect(payload.transferId).toBe("t-1");
    expect(payload.error).toBe("deadlock");
    expect(payload.errorCode).toBe("40P01");
    expect(payload).not.toHaveProperty("newAttemptCount");
    expect(payload).not.toHaveProperty("attemptCount");

    const failure = warnSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_failure",
    );
    expect(failure).toBeUndefined();
    const cap = errorSpy.mock.calls.find(
      (c) => c[0] === "transfer.cap_hit_failed",
    );
    expect(cap).toBeUndefined();
  });

  it("on update error AND RPC error: returns 500, emits no transfer.confirm_failure / cap_hit_failed log", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "pending",
        storage_path: "u-1/t-1/book.epub",
        attempt_count: 4,
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: null,
      error: { message: "first boom", code: "X" },
    });
    supabase._results.set("rpc.increment_transfer_attempt", {
      data: null,
      error: { message: "rpc unreachable" },
    });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(500);

    const warn = warnSpy.mock.calls.find(
      (c) => c[0] === "transfer.confirm_failure",
    );
    const error = errorSpy.mock.calls.find(
      (c) => c[0] === "transfer.cap_hit_failed",
    );
    expect(warn).toBeUndefined();
    expect(error).toBeUndefined();
  });

  it("returns 401 when authenticateDevice errors", async () => {
    const auth = await import("$lib/server/auth");
    (
      auth.authenticateDevice as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ error: "missing_token" });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate-limited", async () => {
    const rl = await import("$lib/server/ratelimit");
    (
      rl.transferConfirmLimiter.limit as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });

    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("returns 404 when row missing", async () => {
    supabase._results.set("book_transfers.select", { data: null, error: null });
    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when transfer.user_id !== device.userId", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "other",
        status: "pending",
        storage_path: "p",
        attempt_count: 0,
      },
      error: null,
    });
    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(404);
  });

  it("returns 409 when status !== 'pending'", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "t-1",
        user_id: "u-1",
        status: "downloaded",
        storage_path: "p",
        attempt_count: 0,
      },
      error: null,
    });
    const res = await POST(buildEvent("t-1"));
    expect(res.status).toBe(409);
  });
});
