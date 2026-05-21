// tests/routes/transfer-initiate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

// Mocks must be declared before importing the route module because route
// imports $env/static/private transitively via ratelimit.ts / supabase.ts.
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  return {
    ...actual,
    transferUploadLimiter: {
      ...actual.transferUploadLimiter,
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
  supabase._resultsQueue.clear();
  supabase._storage.clear();
  supabase._insertCalls.length = 0;
});

describe("POST /api/transfer/initiate — Deploy 2 (sha256 required)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await POST(
      buildEvent({ filename: "a.epub", fileSize: 10 }, null),
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-JSON body with 400", async () => {
    const evt = {
      request: new Request("http://x/api/transfer/initiate", {
        method: "POST",
        body: "not json",
      }),
      locals: {
        safeGetSession: async () => ({ user: { id: "u-1" }, session: null }),
      },
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(evt);
    expect(res.status).toBe(400);
  });

  it("rejects missing filename with 400", async () => {
    const res = await POST(buildEvent({ fileSize: 10 }));
    expect(res.status).toBe(400);
  });

  it("rejects non-.epub filename with 400 invalid_filename", async () => {
    const res = await POST(buildEvent({ filename: "book.pdf", fileSize: 10 }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_filename");
  });

  it("rejects malformed sha256 with 400 invalid_sha256", async () => {
    const res = await POST(
      buildEvent({ filename: "x.epub", fileSize: 10, sha256: "ZZZ" }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_sha256");
  });

  it("accepts a request WITH sha256 and inserts status='pending' directly", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.insert", { data: null, error: null });

    const sha = "a".repeat(64);
    const res = await POST(
      buildEvent({ filename: "book.epub", fileSize: 100, sha256: sha }),
    );

    expect(res.status).toBe(201);
  });

  it("idempotent re-init: pending+unverified row returns existing transferId + fresh uploadUrl (no insert)", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "existing-tx-id",
          storage_path: "u-1/existing-tx-id.epub",
          sha256_verified: null,
        },
      ],
      error: null,
    });
    supabase._storage.set("createSignedUploadUrl", {
      data: { signedUrl: "https://storage/reissued" },
      error: null,
    });

    const sha = "b".repeat(64);
    const res = await POST(
      buildEvent({ filename: "book.epub", fileSize: 100, sha256: sha }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.transferId).toBe("existing-tx-id");
    expect(body.uploadUrl).toBe("https://storage/reissued");
    // Idempotency invariant: no new row was inserted.
    expect(
      supabase._insertCalls.filter((c) => c.table === "book_transfers"),
    ).toHaveLength(0);
  });

  it("returns 409 duplicate_transfer when the existing pending row is already sha256_verified", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "verified-tx-id",
          storage_path: "u-1/verified-tx-id.epub",
          sha256_verified: "b".repeat(64),
        },
      ],
      error: null,
    });

    const sha = "b".repeat(64);
    const res = await POST(
      buildEvent({ filename: "book.epub", fileSize: 100, sha256: sha }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("duplicate_transfer");
  });

  it("23505 race: re-queries existing row and returns same transferId + fresh uploadUrl", async () => {
    // Two sequential SELECTs on book_transfers: dedup lookup (empty) then
    // post-23505 re-query (raced row).
    supabase._resultsQueue.set("book_transfers.select", [
      { data: [], error: null },
      {
        data: [
          {
            id: "raced-tx-id",
            storage_path: "u-1/raced-tx-id.epub",
            sha256_verified: null,
          },
        ],
        error: null,
      },
    ]);
    supabase._results.set("book_transfers.insert", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    supabase._storage.set("createSignedUploadUrl", {
      data: { signedUrl: "https://storage/raced" },
      error: null,
    });

    const sha = "c".repeat(64);
    const res = await POST(
      buildEvent({ filename: "book.epub", fileSize: 100, sha256: sha }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.transferId).toBe("raced-tx-id");
    expect(body.uploadUrl).toBe("https://storage/raced");
  });

  it("same filename, different sha256: not deduped (separate inserts allowed)", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.insert", { data: null, error: null });
    supabase._storage.set("createSignedUploadUrl", {
      data: { signedUrl: "https://storage/new" },
      error: null,
    });

    // First upload of foo.epub with sha A.
    const resA = await POST(
      buildEvent({
        filename: "foo.epub",
        fileSize: 100,
        sha256: "a".repeat(64),
      }),
    );
    expect(resA.status).toBe(201);

    // Second upload, same name, different bytes (different sha) — both pass.
    const resB = await POST(
      buildEvent({
        filename: "foo.epub",
        fileSize: 200,
        sha256: "b".repeat(64),
      }),
    );
    expect(resB.status).toBe(201);

    // Two new rows inserted (no dedup on filename).
    expect(
      supabase._insertCalls.filter((c) => c.table === "book_transfers"),
    ).toHaveLength(2);
  });

  it("rejects missing sha256 with 400 invalid_sha256 (deploy 2)", async () => {
    const res = await POST(buildEvent({ filename: "x.epub", fileSize: 10 }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_sha256");
  });

  it("returns the signed upload URL in the response (sha path)", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.insert", { data: null, error: null });
    supabase._storage.set("createSignedUploadUrl", {
      data: { signedUrl: "https://storage/x" },
      error: null,
    });

    const sha = "d".repeat(64);
    const res = await POST(
      buildEvent({ filename: "book.epub", fileSize: 100, sha256: sha }),
    );
    const body = await res.json();

    expect(body.uploadUrl).toBe("https://storage/x");
  });
});
