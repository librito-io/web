import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../../helpers";

vi.mock("$env/static/private", () => ({
  COVER_STORAGE_BACKEND: "supabase",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  NYT_BOOKS_API_KEY: "",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
  PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc",
}));

import { resolveIsbn } from "../../../src/lib/server/catalog/fetcher";

const NEG_TTL_DAYS = 30;
const fakeOk = { kind: "ok" as const, result: { success: true } as never };
const fakeBlocked = {
  kind: "ok" as const,
  result: { success: false } as never,
};

function deps(overrides: Partial<Parameters<typeof resolveIsbn>[2]> = {}) {
  return {
    fetchFn: vi.fn(),
    rateLimiters: {
      openLibrary: { limit: vi.fn(async () => fakeOk.result) },
      googleBooks: { limit: vi.fn(async () => fakeOk.result) },
    },
    coverStorage: {
      uploadCover: vi.fn(async () => ({
        storage_path: "ab/cd.jpg",
        backend: "supabase" as const,
        image_sha256: "deadbeef".repeat(8),
      })),
    },
    now: () => new Date("2026-05-02T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveIsbn", () => {
  it("returns existing positive cache row without fetching", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        { isbn: "9780743273565", storage_path: "x/y.jpg", title: "Gatsby" },
      ],
      error: null,
    });
    const d = deps();
    const r = await resolveIsbn(supabase as never, "9780743273565", d);
    expect(r.cached).toBe(true);
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("returns existing negative cache row when within TTL", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: "9780743273565",
          storage_path: null,
          last_attempted_at: "2026-04-25T00:00:00Z", // 7 days ago
        },
      ],
      error: null,
    });
    const d = deps();
    const r = await resolveIsbn(supabase as never, "9780743273565", d);
    expect(r.cached).toBe(true);
    expect(r.row.storage_path).toBeNull();
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("retries when negative cache exceeds TTL", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: "9780743273565",
          storage_path: null,
          last_attempted_at: "2026-03-01T00:00:00Z", // > 30d ago
        },
      ],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });
    const d = deps({
      fetchFn: vi.fn(async (input: URL | RequestInfo) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/books?bibkeys=ISBN")) {
          return new Response(
            JSON.stringify({ "ISBN:9780743273565": { title: "Gatsby" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(new Uint8Array(2048), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }) as unknown as typeof fetch,
    });
    const r = await resolveIsbn(supabase as never, "9780743273565", d);
    expect(d.fetchFn).toHaveBeenCalled();
    expect(r.cached).toBe(false);
  });

  it("aborts and returns existing row when rate-limit budget is empty (no attempt_count bump)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    const d = deps({
      rateLimiters: {
        openLibrary: {
          limit: vi.fn(async () => ({ success: false }) as never),
        },
        googleBooks: {
          limit: vi.fn(async () => ({ success: false }) as never),
        },
      },
    });
    const r = await resolveIsbn(supabase as never, "9780743273565", d);
    expect(r.rateLimited).toBe(true);
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an invalid ISBN", async () => {
    const supabase = createMockSupabase();
    const d = deps();
    await expect(resolveIsbn(supabase as never, "00000", d)).rejects.toThrow(
      /InvalidIsbn/,
    );
  });
});
