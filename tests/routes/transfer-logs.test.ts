// tests/routes/transfer-logs.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$lib/server/ratelimit", () => ({
  transferUploadLimiter: {
    limit: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
  transferDownloadLimiter: {
    limit: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

vi.mock("$lib/server/auth", () => ({
  authenticateDevice: vi.fn(async () => ({
    device: { id: "d-1", userId: "u-1" },
  })),
}));

beforeEach(() => {
  supabase._results.clear();
  supabase._storage.clear();
});

describe("transfer log catalog — defensive shape freeze", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("emits transfer.initiate at info with {transferId, userId, filenameLen, fileSize, sha256} on successful insert", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.select.count", {
      data: null,
      error: null,
      count: 0,
    } as never);
    supabase._results.set("book_transfers.insert", { data: null, error: null });
    supabase._storage.set("createSignedUploadUrl", {
      data: { signedUrl: "https://storage/x" },
      error: null,
    });

    const { POST } =
      await import("../../src/routes/api/transfer/initiate/+server");
    const sha = "a".repeat(64);
    const evt = {
      request: new Request("http://x/api/transfer/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "book.epub",
          fileSize: 100,
          sha256: sha,
        }),
      }),
      locals: {
        safeGetSession: async () => ({ user: { id: "u-1" }, session: null }),
      },
    } as unknown as Parameters<typeof POST>[0];

    await POST(evt);

    const initiateCall = infoSpy.mock.calls.find(
      (c) => c[0] === "transfer.initiate",
    );
    expect(initiateCall).toBeDefined();
    const payload = initiateCall![1] as Record<string, unknown>;
    expect(typeof payload.transferId).toBe("string");
    expect(payload.userId).toBe("u-1");
    expect(payload.filenameLen).toBe("book.epub".length);
    expect(typeof payload.filenameLen).toBe("number");
    expect(payload.fileSize).toBe(100);
    expect(payload.sha256).toBe(sha);
  });

  it("emits transfer.download_url_issued at info with {transferId, userId, deviceId, ttl} after URL mint", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "t-1",
          user_id: "u-1",
          device_id: null,
          status: "pending",
          storage_path: "u-1/t-1/book.epub",
          sha256: "f".repeat(64),
          filename: "book.epub",
          file_size: 100,
        },
      ],
      error: null,
    });

    const { GET } =
      await import("../../src/routes/api/transfer/[id]/download-url/+server");
    const evt = {
      request: new Request("http://x/api/transfer/t-1/download-url", {
        headers: { Authorization: "Bearer sk_device_xxx" },
      }),
      params: { id: "t-1" },
    } as unknown as Parameters<typeof GET>[0];

    await GET(evt);

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
});
