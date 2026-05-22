// tests/routes/transfer-logs.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  const allow = () =>
    vi.fn(async () => ({
      success: true,
      reset: Date.now() + 60_000,
      limit: 5,
      remaining: 4,
      pending: Promise.resolve(),
    }));
  return {
    ...actual,
    transferUploadLimiter: { ...actual.transferUploadLimiter, limit: allow() },
    transferDownloadLimiter: {
      ...actual.transferDownloadLimiter,
      limit: allow(),
    },
    transferConfirmLimiter: {
      ...actual.transferConfirmLimiter,
      limit: allow(),
    },
    transferRetryLimiter: { ...actual.transferRetryLimiter, limit: allow() },
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

vi.mock("$lib/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/auth")>();
  return {
    ...actual,
    authenticateDevice: vi.fn(async () => ({
      device: { id: "d-1", userId: "u-1" },
    })),
  };
});

beforeEach(() => {
  supabase._results.clear();
  supabase._storage.clear();
});

describe("transfer log catalog — defensive shape freeze", () => {
  let logWrites: Record<string, unknown>[];

  beforeEach(() => {
    logWrites = [];
    __setTestDestination((line) => logWrites.push(JSON.parse(line)));
  });
  afterEach(() => {
    __resetTestDestination();
  });

  it("emits transfer.initiate at info with {transferId, userId, filenameLen, fileSize, sha256Prefix} on successful insert", async () => {
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
      await import("../../src/routes/app/api/transfer/initiate/+server");
    const sha = "a".repeat(64);
    const evt = {
      request: new Request("http://x/app/api/transfer/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "book.epub",
          fileSize: 100,
          sha256: sha,
        }),
      }),
      locals: { user: { id: "u-1" } },
    } as unknown as Parameters<typeof POST>[0];

    await POST(evt);

    const initiateCall = logWrites.find((w) => w.event === "transfer.initiate");
    expect(initiateCall).toBeDefined();
    const payload = initiateCall as Record<string, unknown>;
    expect(typeof payload.transferId).toBe("string");
    expect(payload.userId).toBe("u-1");
    expect(payload.filenameLen).toBe("book.epub".length);
    expect(typeof payload.filenameLen).toBe("number");
    expect(payload.fileSize).toBe(100);
    expect(payload.sha256Prefix).toBe(sha.slice(0, 12));
  });

  it("emits transfer.download_url_issued at info with {transferId, userId, deviceId, ttl} after URL mint", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: "u-1",
          device_id: null,
          status: "pending",
          storage_path: "u-1/11111111-1111-4111-8111-111111111111/book.epub",
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
      request: new Request(
        "http://x/api/transfer/11111111-1111-4111-8111-111111111111/download-url",
        {
          headers: { Authorization: "Bearer sk_device_xxx" },
        },
      ),
      params: { id: "11111111-1111-4111-8111-111111111111" },
    } as unknown as Parameters<typeof GET>[0];

    await GET(evt);

    const call = logWrites.find(
      (w) => w.event === "transfer.download_url_issued",
    );
    expect(call).toBeDefined();
    const payload = call as Record<string, unknown>;
    expect(payload.transferId).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.userId).toBe("u-1");
    expect(payload.deviceId).toBe("d-1");
    expect(typeof payload.ttl).toBe("number");
  });

  it("emits transfer.retry_reset at info with {transferId, userId, previousAttemptCount, previousLastError}", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: "u-1",
        status: "failed",
        attempt_count: 10,
        last_error: "x",
      },
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: "11111111-1111-4111-8111-111111111111" }],
      error: null,
    });

    const { POST } =
      await import("../../src/routes/app/api/transfer/[id]/retry/+server");
    const evt = {
      params: { id: "11111111-1111-4111-8111-111111111111" },
      request: new Request(
        "http://x/app/api/transfer/11111111-1111-4111-8111-111111111111/retry",
        {
          method: "POST",
        },
      ),
      locals: { user: { id: "u-1" } },
    } as unknown as Parameters<typeof POST>[0];
    await POST(evt);

    const call = logWrites.find((w) => w.event === "transfer.retry_reset");
    expect(call).toBeDefined();
    const payload = call as Record<string, unknown>;
    expect(payload.transferId).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.userId).toBe("u-1");
    expect(payload.previousAttemptCount).toBe(10);
    expect(payload.previousLastError).toBe("x");
  });
});
