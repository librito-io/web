// tests/routes/transfer-finalize.test.ts
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
    transferFinalizeLimiter: {
      ...actual.transferFinalizeLimiter,
      limit: vi.fn(async () => ({
        success: true,
        reset: Date.now() + 60_000,
        limit: 5,
        remaining: 4,
        pending: Promise.resolve(),
      })),
    },
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } =
  await import("../../src/routes/api/transfer/[id]/finalize/+server");

const TRANSFER_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "u-1";
const STORAGE_PATH = `${USER_ID}/${TRANSFER_ID}.epub`;

// sha256("hello") — used as the "expected" client-claim in tests.
const HELLO_SHA =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const HELLO_BYTES = new TextEncoder().encode("hello");

function buildEvent(
  transferId: string,
  user: { id: string } | null = { id: USER_ID },
) {
  return {
    request: new Request(`http://x/api/transfer/${transferId}/finalize`, {
      method: "POST",
    }),
    params: { id: transferId },
    locals: { safeGetSession: async () => ({ user, session: null }) },
  } as unknown as Parameters<typeof POST>[0];
}

function blobFrom(bytes: Uint8Array): Blob {
  // Copy into a fresh ArrayBuffer to satisfy TS's Blob BlobPart narrowing —
  // the underlying buffer on a TextEncoder/encode result is ArrayBufferLike
  // (which includes SharedArrayBuffer), but Blob() insists on ArrayBuffer.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy]);
}

beforeEach(() => {
  supabase._results.clear();
  supabase._storage.clear();
  supabase._updateCalls.length = 0;
});

describe("POST /api/transfer/[id]/finalize", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await POST(buildEvent(TRANSFER_ID, null));
    expect(res.status).toBe(401);
  });

  it("returns 404 on malformed transfer UUID", async () => {
    const res = await POST(buildEvent("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when transfer does not exist", async () => {
    supabase._results.set("book_transfers.select", { data: null, error: null });
    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(404);
  });

  it("returns 404 when transfer belongs to another user", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: "u-other",
        status: "pending",
        storage_path: STORAGE_PATH,
        sha256: HELLO_SHA,
        sha256_verified: null,
      },
      error: null,
    });
    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(404);
  });

  it("returns 404 on a scrubbed row (handler filters scrubbed_at IS NULL)", async () => {
    supabase._results.set("book_transfers.select", { data: null, error: null });
    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(404);

    const selectChain = supabase._chainCalls.find(
      (c) =>
        c.table === "book_transfers" &&
        c.operation === "select" &&
        c.method === "is" &&
        c.args[0] === "scrubbed_at" &&
        c.args[1] === null,
    );
    expect(selectChain).toBeDefined();
  });

  it("returns 409 when transfer is not in pending status and not yet verified", async () => {
    // Edge: a 'failed' row from a prior /finalize mismatch — the
    // browser should not be able to re-trigger verification on it.
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: USER_ID,
        status: "failed",
        storage_path: STORAGE_PATH,
        sha256: HELLO_SHA,
        sha256_verified: null,
      },
      error: null,
    });
    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(409);
  });

  it("returns 200 idempotently when sha256_verified is already set and matches", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: USER_ID,
        status: "pending",
        storage_path: STORAGE_PATH,
        sha256: HELLO_SHA,
        sha256_verified: HELLO_SHA,
      },
      error: null,
    });
    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(200);
    // No new hash compute / no UPDATE write — the row is already verified.
    expect(supabase._updateCalls.length).toBe(0);
  });

  it("returns 500 when storage download fails", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: USER_ID,
        status: "pending",
        storage_path: STORAGE_PATH,
        sha256: HELLO_SHA,
        sha256_verified: null,
      },
      error: null,
    });
    supabase._storage.set(`download.book-transfers.${STORAGE_PATH}`, {
      data: null,
      error: { message: "object missing" },
    });
    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(500);
  });

  it("on hash match: writes sha256_verified + verified_at and returns 200", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: USER_ID,
        status: "pending",
        storage_path: STORAGE_PATH,
        sha256: HELLO_SHA,
        sha256_verified: null,
      },
      error: null,
    });
    supabase._storage.set(`download.book-transfers.${STORAGE_PATH}`, {
      data: blobFrom(HELLO_BYTES),
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: TRANSFER_ID }],
      error: null,
    });

    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(200);

    const update = supabase._updateCalls.find(
      (u) => u.table === "book_transfers",
    );
    expect(update).toBeDefined();
    const payload = update!.payload as Record<string, unknown>;
    expect(payload.sha256_verified).toBe(HELLO_SHA);
    expect(typeof payload.verified_at).toBe("string");
  });

  it("on hash match: UPDATE is guarded by status='pending' AND sha256_verified IS NULL (TOCTOU close)", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: USER_ID,
        status: "pending",
        storage_path: STORAGE_PATH,
        sha256: HELLO_SHA,
        sha256_verified: null,
      },
      error: null,
    });
    supabase._storage.set(`download.book-transfers.${STORAGE_PATH}`, {
      data: blobFrom(HELLO_BYTES),
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: TRANSFER_ID }],
      error: null,
    });

    await POST(buildEvent(TRANSFER_ID));

    const updateChainCalls = supabase._chainCalls.filter(
      (c) => c.table === "book_transfers" && c.operation === "update",
    );
    const statusGuard = updateChainCalls.find(
      (c) =>
        c.method === "eq" && c.args[0] === "status" && c.args[1] === "pending",
    );
    const verifiedGuard = updateChainCalls.find(
      (c) =>
        c.method === "is" &&
        c.args[0] === "sha256_verified" &&
        c.args[1] === null,
    );
    expect(statusGuard).toBeDefined();
    expect(verifiedGuard).toBeDefined();
  });

  it("on hash mismatch: flips status to 'failed' with last_error='sha256_mismatch' and returns 422", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: USER_ID,
        status: "pending",
        storage_path: STORAGE_PATH,
        // Client claimed HELLO_SHA but stored bytes are different.
        sha256: HELLO_SHA,
        sha256_verified: null,
      },
      error: null,
    });
    supabase._storage.set(`download.book-transfers.${STORAGE_PATH}`, {
      data: blobFrom(new TextEncoder().encode("not hello")),
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: TRANSFER_ID }],
      error: null,
    });

    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(422);

    const update = supabase._updateCalls.find(
      (u) => u.table === "book_transfers",
    );
    expect(update).toBeDefined();
    const payload = update!.payload as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(payload.last_error).toBe("sha256_mismatch");
    // The verified columns must NOT be written on mismatch — leaves them
    // NULL so the row stays out of the sync gate.
    expect(payload.sha256_verified).toBeUndefined();
  });

  it("on guarded UPDATE returning zero rows (race): returns 409 without falsely claiming success", async () => {
    supabase._results.set("book_transfers.select", {
      data: {
        id: TRANSFER_ID,
        user_id: USER_ID,
        status: "pending",
        storage_path: STORAGE_PATH,
        sha256: HELLO_SHA,
        sha256_verified: null,
      },
      error: null,
    });
    supabase._storage.set(`download.book-transfers.${STORAGE_PATH}`, {
      data: blobFrom(HELLO_BYTES),
      error: null,
    });
    supabase._results.set("book_transfers.update", { data: [], error: null });

    const res = await POST(buildEvent(TRANSFER_ID));
    expect(res.status).toBe(409);
  });
});
