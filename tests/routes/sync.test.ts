import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$lib/server/auth", () => ({
  authenticateDevice: vi.fn(async () => ({
    device: { id: "d-1", userId: "u-1" },
  })),
  authErrorResponse: vi.fn(),
}));

const limitMock = vi.fn();
vi.mock("$lib/server/ratelimit", async () => {
  const { passThroughEnforceRateLimit } = await import("../helpers");
  return {
    syncLimiter: {
      limit: (...args: unknown[]) => limitMock(...args),
      label: "sync:device",
      failMode: "open" as const,
    },
    enforceRateLimit: passThroughEnforceRateLimit,
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const processSyncMock = vi.fn(async () => ({
  syncedAt: 0,
  notes: [],
  deletedHighlights: [],
  deletedNotes: [],
  pendingTransfers: [],
  failedTransferCount: 0,
}));
vi.mock("$lib/server/sync", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    processSync: processSyncMock,
  };
});

const { POST } = await import("../../src/routes/api/sync/+server");

beforeEach(() => {
  limitMock.mockReset();
  processSyncMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildEvent(body: unknown) {
  return {
    request: new Request("http://x/api/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer sk_device_xxx",
      },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/sync — fail-open under Upstash outage", () => {
  it("proceeds to processSync (200) when syncLimiter throws", async () => {
    limitMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(buildEvent({ lastSyncedAt: 0, books: [] }));

    expect(res.status).toBe(200);
    expect(processSyncMock).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("returns 429 when syncLimiter denies", async () => {
    limitMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 12_000,
      limit: 1,
      remaining: 0,
      pending: Promise.resolve(),
    });

    const res = await POST(buildEvent({ lastSyncedAt: 0, books: [] }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(processSyncMock).not.toHaveBeenCalled();
  });
});
