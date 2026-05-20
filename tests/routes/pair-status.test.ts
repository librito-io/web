// tests/routes/pair-status.test.ts
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
    redis: { get: vi.fn(async () => null) },
    pairStatusLimiter: {
      ...actual.pairStatusLimiter,
      limit: vi.fn(async () => ({
        success: true,
        reset: Date.now() + 60_000,
        limit: 1,
        remaining: 0,
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
  await import("../../src/routes/api/pair/status/[pairingId]/+server");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

// SHA-256 of "device-held-secret" — production code in checkPairingStatus
// hashes the presented secret and compares to the stored hash, so the
// route-level tests need a real hash pair to drive the verify branch.
const DEVICE_SECRET = "device-held-secret";
const DEVICE_SECRET_HASH =
  "2e061994eed9393b7ab719b700330b1da390577b5c10000b823bcb07f29accd6";

function buildEvent(
  pairingId: string,
  opts: { authHeader?: string; query?: string } = {},
) {
  const search = opts.query ? `?${opts.query}` : "";
  const headers = new Headers();
  if (opts.authHeader) headers.set("Authorization", opts.authHeader);
  return {
    params: { pairingId },
    url: new URL(`http://x/api/pair/status/${pairingId}${search}`),
    request: new Request(`http://x/api/pair/status/${pairingId}${search}`, {
      method: "GET",
      headers,
    }),
    getClientAddress: () => "1.2.3.4",
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /api/pair/status/[pairingId]", () => {
  beforeEach(() => {
    supabase._results.clear();
  });

  it("returns 404 on malformed UUID with no DB or rate-limit call", async () => {
    const rl = await import("$lib/server/ratelimit");
    const res = await GET(buildEvent("not-a-uuid"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    expect(rl.pairStatusLimiter.limit).not.toHaveBeenCalled();
  });

  it("delegates to checkPairingStatus on valid UUID", async () => {
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: null,
    });
    const res = await GET(buildEvent(VALID_ID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  // ---- pollSecret challenge wire shape (issue #286 step 2) ----

  it("forwards Authorization: Bearer header value to checkPairingStatus and returns 401 on mismatch", async () => {
    // The row carries a hash, the caller presents the wrong secret →
    // route maps poll_secret_mismatch to 401 / unauthorized.
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: "u@example.com",
        poll_secret_hash: DEVICE_SECRET_HASH,
      },
      error: null,
    });
    const res = await GET(
      buildEvent(VALID_ID, { authHeader: "Bearer wrong-secret" }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("admits Bearer header when secret matches the stored hash", async () => {
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: null,
        poll_secret_hash: DEVICE_SECRET_HASH,
      },
      error: null,
    });
    const res = await GET(
      buildEvent(VALID_ID, { authHeader: `Bearer ${DEVICE_SECRET}` }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).paired).toBe(false);
  });

  it("falls back to ?pollSecret= query param when no Authorization header is set", async () => {
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: null,
        poll_secret_hash: DEVICE_SECRET_HASH,
      },
      error: null,
    });
    const res = await GET(
      buildEvent(VALID_ID, {
        query: `pollSecret=${encodeURIComponent(DEVICE_SECRET)}`,
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).paired).toBe(false);
  });
});
