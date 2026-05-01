// tests/routes/transfer-download-url.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$lib/server/auth", async () => {
  const { jsonError } = await import("../../src/lib/server/errors");
  return {
    authenticateDevice: vi.fn(async () => ({
      device: { id: "d-1", userId: "u-1" },
    })),
    authErrorResponse: vi.fn((code: string) =>
      jsonError(401, code, "Device authentication failed"),
    ),
  };
});

vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  return {
    ...actual,
    transferDownloadLimiter: {
      ...actual.transferDownloadLimiter,
      limit: vi.fn(async () => ({
        success: true,
        reset: Date.now() + 60_000,
        limit: 10,
        remaining: 9,
        pending: Promise.resolve(),
      })),
    },
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { GET } =
  await import("../../src/routes/api/transfer/[id]/download-url/+server");

function buildEvent(transferId: string) {
  return {
    request: new Request(`http://x/api/transfer/${transferId}/download-url`, {
      headers: { Authorization: "Bearer sk_device_xxx" },
    }),
    params: { id: transferId },
  } as unknown as Parameters<typeof GET>[0];
}

const pendingTransfer = {
  id: "t-1",
  user_id: "u-1",
  device_id: null,
  status: "pending",
  storage_path: "u-1/t-1/book.epub",
  sha256: "a".repeat(64),
  filename: "book.epub",
};

describe("GET /api/transfer/[id]/download-url — WS-D", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    supabase._results.clear();
    supabase._storage.clear();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("returns downloadUrl, transferId, sha256, filename on success", async () => {
    supabase._results.set("book_transfers.select", {
      data: [pendingTransfer],
      error: null,
    });

    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.downloadUrl).toContain("book.epub");
    expect(body.transferId).toBe("t-1");
    expect(body.sha256).toBe("a".repeat(64));
    expect(body.filename).toBe("book.epub");
  });

  it("emits transfer.download_url_issued at info with {transferId, userId, deviceId, ttl}", async () => {
    supabase._results.set("book_transfers.select", {
      data: [pendingTransfer],
      error: null,
    });

    await GET(buildEvent("t-1"));

    const call = infoSpy.mock.calls.find(
      (c) => c[0] === "transfer.download_url_issued",
    );
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload.transferId).toBe("t-1");
    expect(payload.userId).toBe("u-1");
    expect(payload.deviceId).toBe("d-1");
    expect(typeof payload.ttl).toBe("number");
  });

  it("returns 401 when authenticateDevice errors", async () => {
    const auth = await import("$lib/server/auth");
    (
      auth.authenticateDevice as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ error: "missing_token" });

    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate-limited", async () => {
    const rl = await import("$lib/server/ratelimit");
    (
      rl.transferDownloadLimiter.limit as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });

    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("returns 404 when row missing", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when transfer.user_id !== device.userId", async () => {
    supabase._results.set("book_transfers.select", {
      data: [{ ...pendingTransfer, user_id: "other" }],
      error: null,
    });
    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(404);
  });

  it("returns 409 when status !== 'pending'", async () => {
    supabase._results.set("book_transfers.select", {
      data: [{ ...pendingTransfer, status: "downloaded" }],
      error: null,
    });
    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(409);
  });

  it("returns 404 when device_id set to a different device", async () => {
    supabase._results.set("book_transfers.select", {
      data: [{ ...pendingTransfer, device_id: "other-device" }],
      error: null,
    });
    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(404);
  });

  it("returns 500 on DB fetch error", async () => {
    supabase._results.set("book_transfers.select", {
      data: null,
      error: { message: "db error" },
    });
    const res = await GET(buildEvent("t-1"));
    expect(res.status).toBe(500);
  });
});
