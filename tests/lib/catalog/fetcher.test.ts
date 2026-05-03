import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../../helpers";

vi.mock("$env/static/private", () => ({
  COVER_STORAGE_BACKEND: "supabase",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: {
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_IMAGES_API_TOKEN: "tok",
    NYT_BOOKS_API_KEY: "",
  },
}));
vi.mock("$env/dynamic/public", () => ({
  env: { PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc" },
}));

import {
  resolveIsbn,
  resolveTitleAuthor,
} from "../../../src/lib/server/catalog/fetcher";

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

describe("resolveTitleAuthor", () => {
  it("rejects empty title or author", async () => {
    const supabase = createMockSupabase();
    await expect(
      resolveTitleAuthor(supabase as never, "", "x", deps()),
    ).rejects.toThrow(/InvalidTitleAuthor/);
  });

  it("returns cached row keyed on normalized_title_author", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: null,
          normalized_title_author: "the great gatsby|f scott fitzgerald",
          storage_path: "x/y.jpg",
        },
      ],
      error: null,
    });
    const d = deps();
    const r = await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      d,
    );
    expect(r.cached).toBe(true);
    expect(d.fetchFn).not.toHaveBeenCalled();
  });
});

// ─── do_not_refetch_description flag ────────────────────────────────────────

describe("resolveIsbn – do_not_refetch_description", () => {
  // Existing row that is past the negative-cache TTL so the resolver runs,
  // but has the takedown flag set.
  function makeStaleRow(flag: boolean) {
    return {
      isbn: "9780743273565",
      storage_path: null,
      description: null,
      do_not_refetch_description: flag,
      // > 30 days before "now" (2026-05-02), so NOT a fresh negative-cache hit.
      last_attempted_at: "2026-03-01T00:00:00Z",
      attempt_count: 1,
    };
  }

  function makeFetchFn(respondToOl = true) {
    return vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org")) {
        if (url.includes("/api/books")) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/search.json")) {
          return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/works/")) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (respondToOl && url.includes("covers.openlibrary.org")) {
          return new Response(new Uint8Array(2048), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        }
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          JSON.stringify({
            kind: "books#volumes",
            totalItems: 1,
            items: [
              {
                id: "gbid1",
                volumeInfo: {
                  title: "The Great Gatsby",
                  description: "A story about the American dream.",
                  imageLinks: {
                    thumbnail: "https://books.google.com/cover.jpg",
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Default: empty image bytes for cover fetches
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;
  }

  it("honors flag: GB JSON is called but description not applied when do_not_refetch_description=true", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(true)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const fetchFn = makeFetchFn();
    const r = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    // GB JSON call should still happen (cover fallback allowed); description NOT applied.
    const gbJsonCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("googleapis.com/books"),
    );
    expect(gbJsonCalls.length).toBeGreaterThan(0);
    expect(r.row.description).toBeNull();
  });

  it("no flag: hits Google Books normally when do_not_refetch_description=false", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(false)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const fetchFn = makeFetchFn();
    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const gbCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("googleapis.com/books"),
    );
    expect(gbCalls.length).toBeGreaterThan(0);
  });

  it("flag: description null in upsert RPC payload even though GB JSON was called", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(true)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const fetchFn = makeFetchFn();
    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.description).toBeNull();
  });

  it("flag set + no OL cover → GB cover fallback applied", async () => {
    // Existing row past TTL with takedown flag. No OL cover. GB has a thumbnail.
    const supabase = createMockSupabase();
    // Queue two select results: first for selectByIsbn (stale row), second for
    // selectBySha dedup (no match → null, so uploadCover runs).
    supabase._resultsQueue.set("book_catalog.select", [
      {
        data: [
          {
            isbn: "9780743273565",
            storage_path: null,
            description: null,
            do_not_refetch_description: true,
            last_attempted_at: "2026-03-01T00:00:00Z",
            attempt_count: 1,
          },
        ],
        error: null,
      },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const GB_COVER_URL = "https://books.google.com/books/cover-fallback.jpg";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL ISBN lookup — no cover field
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(
          JSON.stringify({ "ISBN:9780743273565": { title: "Foo" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OL search — no cover_i
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL works
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // GB volumes JSON — has thumbnail imageLink
      if (url.includes("googleapis.com/books")) {
        return new Response(
          JSON.stringify({
            kind: "books#volumes",
            totalItems: 1,
            items: [
              {
                id: "gbid_cover",
                volumeInfo: {
                  title: "Foo",
                  description: "Marketing blurb to be ignored.",
                  imageLinks: { thumbnail: GB_COVER_URL },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // GB cover image bytes
      if (url === GB_COVER_URL) {
        return new Response(new Uint8Array(2048), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    // GB JSON URL was hit
    const gbJsonCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("googleapis.com/books"),
    );
    expect(gbJsonCalls.length).toBeGreaterThan(0);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;

    // Flag respected: description still null
    expect(p_row.description).toBeNull();
    // Cover came from GB fallback
    expect(p_row.storage_path).not.toBeNull();
    expect(p_row.cover_source).toBe("google_books");
  });

  it("flag set + OL cover present → GB cover URL not fetched", async () => {
    // Existing row past TTL with takedown flag. OL has a cover. GB should not
    // be used as a cover source.
    const supabase = createMockSupabase();
    // Queue two select results: first for selectByIsbn, second for selectBySha dedup.
    supabase._resultsQueue.set("book_catalog.select", [
      {
        data: [
          {
            isbn: "9780743273565",
            storage_path: null,
            description: null,
            do_not_refetch_description: true,
            last_attempted_at: "2026-03-01T00:00:00Z",
            attempt_count: 1,
          },
        ],
        error: null,
      },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const GB_COVER_URL = "https://books.google.com/books/should-not-be-hit.jpg";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL ISBN lookup — with a cover.large containing a cover id
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(
          JSON.stringify({
            "ISBN:9780743273565": {
              title: "Gatsby",
              cover: {
                large: "https://covers.openlibrary.org/b/id/12345-L.jpg",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OL works
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL cover bytes
      if (url.includes("covers.openlibrary.org")) {
        return new Response(new Uint8Array(2048), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB volumes JSON — has thumbnail (should not be used for cover)
      if (url.includes("googleapis.com/books")) {
        return new Response(
          JSON.stringify({
            kind: "books#volumes",
            totalItems: 1,
            items: [
              {
                id: "gbid_skip",
                volumeInfo: {
                  title: "Gatsby",
                  description: "Some blurb.",
                  imageLinks: { thumbnail: GB_COVER_URL },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Fallback
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    // GB cover URL was NOT fetched
    const gbCoverCalls = (
      fetchFn as ReturnType<typeof vi.fn>
    ).mock.calls.filter((args: unknown[]) => String(args[0]) === GB_COVER_URL);
    expect(gbCoverCalls).toHaveLength(0);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;

    // Flag respected: description still null
    expect(p_row.description).toBeNull();
    // Cover came from Open Library, not GB
    expect(p_row.cover_source).toBe("openlibrary_isbn");
  });
});

describe("resolveTitleAuthor – do_not_refetch_description", () => {
  function makeStaleRow(flag: boolean) {
    return {
      isbn: null,
      normalized_title_author: "the great gatsby|f scott fitzgerald",
      storage_path: null,
      description: null,
      do_not_refetch_description: flag,
      last_attempted_at: "2026-03-01T00:00:00Z",
      attempt_count: 1,
    };
  }

  function makeFetchFn() {
    return vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          JSON.stringify({
            kind: "books#volumes",
            totalItems: 1,
            items: [
              {
                id: "gbid2",
                volumeInfo: {
                  title: "The Great Gatsby",
                  description: "A story about the American dream.",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;
  }

  it("honors flag: GB JSON is called but description not applied when do_not_refetch_description=true", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(true)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });

    const fetchFn = makeFetchFn();
    const r = await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      deps({ fetchFn }),
    );

    // GB JSON call should still happen (cover fallback allowed); description NOT applied.
    const gbJsonCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("googleapis.com/books"),
    );
    expect(gbJsonCalls.length).toBeGreaterThan(0);
    expect(r.row.description).toBeNull();
  });
});
