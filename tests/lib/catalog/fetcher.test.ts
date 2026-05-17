import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createMockSupabase } from "../../helpers";

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: {
    COVER_STORAGE_BACKEND: "supabase",
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Real JPEG files so decodeImageDimensions can parse width/height.

const FIXTURE_DIR = join(__dirname, "../../fixtures/catalog");

function loadFixture(name: string): Uint8Array<ArrayBuffer> {
  const buf = readFileSync(join(FIXTURE_DIR, name));
  // Allocate a fresh ArrayBuffer so TS sees Uint8Array<ArrayBuffer>
  // (not Uint8Array<ArrayBufferLike>) — required for passing to new Response().
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Uint8Array(ab as ArrayBuffer);
}

// 600×900 — passes basic floor (300) but fails premium floor (1200)
const FIXTURE_600x900 = loadFixture("600x900.jpg");
// 1500×2250 — passes premium floor (1200)
const FIXTURE_1500x2250 = loadFixture("1500x2250.jpg");
// 143×218 — fails OL minBytes (1024) → effectively below any floor
const FIXTURE_143x218 = loadFixture("143x218.jpg");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fakeOk = { kind: "ok" as const, result: { success: true } as never };

function deps(overrides: Partial<Parameters<typeof resolveIsbn>[2]> = {}) {
  return {
    fetchFn: vi.fn(),
    rateLimiters: {
      openLibrary: { limit: vi.fn(async () => fakeOk.result) },
      googleBooks: { limit: vi.fn(async () => fakeOk.result) },
      itunes: { limit: vi.fn(async () => fakeOk.result) },
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

function denyAll() {
  return {
    openLibrary: { limit: vi.fn(async () => ({ success: false }) as never) },
    googleBooks: { limit: vi.fn(async () => ({ success: false }) as never) },
    itunes: { limit: vi.fn(async () => ({ success: false }) as never) },
  };
}

/** Stale row: past the 30-day negative-cache TTL. */
function staleNegativeRow(extra: Record<string, unknown> = {}) {
  return {
    isbn: "9780743273565",
    storage_path: null,
    description: null,
    last_attempted_at: "2026-03-01T00:00:00Z", // >30d before "now" (2026-05-02)
    attempt_count: 1,
    ...extra,
  };
}

/** Build a GB volumes JSON response with the given imageLinks. */
function gbVolumesResponse(
  imageLinks: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    kind: "books#volumes",
    totalItems: 1,
    items: [
      {
        id: "gbid1",
        volumeInfo: {
          title: "The Great Gatsby",
          imageLinks: Object.keys(imageLinks).length ? imageLinks : undefined,
          ...extra,
        },
      },
    ],
  });
}

/** Build an iTunes lookup JSON response with the given artworkUrl. */
function itunesResponse(artworkUrl: string) {
  return JSON.stringify({
    resultCount: 1,
    results: [
      {
        wrapperType: "audiobook",
        artistName: "F. Scott Fitzgerald",
        trackName: "The Great Gatsby",
        artworkUrl60: artworkUrl,
        artworkUrl100: artworkUrl,
      },
    ],
  });
}

/** Build a bare OL ISBN lookup response with no cover. */
function olNoCoverResponse() {
  return JSON.stringify({ "ISBN:9780743273565": { title: "Foo" } });
}

/** Build an OL ISBN lookup response with cover_id embedded in the URL. */
function olWithCoverResponse(coverId = "12345") {
  return JSON.stringify({
    "ISBN:9780743273565": {
      title: "Gatsby",
      cover: {
        large: `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`,
      },
    },
  });
}

beforeEach(() => vi.clearAllMocks());

// ─── Basic cache / validation tests ──────────────────────────────────────────

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
    const d = deps({ rateLimiters: denyAll() });
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

// ─── Resolver chain cover tests ───────────────────────────────────────────────

describe("resolveIsbn – resolver chain cover", () => {
  /** Standard supabase setup for a cold-miss resolve (no existing row). */
  function coldMissSupabase() {
    const supabase = createMockSupabase();
    // 1st select → selectByIsbn (miss); 2nd → selectBySha (no dedup hit)
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });
    return supabase;
  }

  it("GB extraLarge native 1200+ wins on first try", async () => {
    // GB returns imageLinks with an extraLarge URL that serves 1500×2250 JPEG.
    // Chain should pick GB on the premium pass and never reach iTunes or OL.
    const supabase = coldMissSupabase();
    const GB_URL =
      "https://books.google.com/books/content?id=abc&printsec=frontcover&img=1&zoom=0";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse({ extraLarge: GB_URL }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // GB cover image — serve 1500×2250 fixture
      if (url.includes("books.google.com")) {
        return new Response(FIXTURE_1500x2250, {
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

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("google_books");
    expect(p_row.cover_max_width).toBeGreaterThanOrEqual(1200);
    expect(p_row.storage_path).not.toBeNull();

    // iTunes should not have been called
    const itunesCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("itunes.apple.com"),
    );
    expect(itunesCalls).toHaveLength(0);
  });

  it("GB low-res falls through to iTunes; iTunes 1400+ wins", async () => {
    // GB has no imageLinks → tryGoogleBooksExtraLarge returns null.
    // iTunes lookup returns artworkUrl100 → serve 1500×2250 JPEG.
    const supabase = coldMissSupabase();
    const ITUNES_URL =
      "https://is1-ssl.mzstatic.com/image/thumb/Music/foo/100x100bb.jpg";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // GB — no imageLinks
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // iTunes lookup
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(itunesResponse(ITUNES_URL), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // iTunes cover image — serve 1500×2250 fixture (upgraded URL pattern)
      if (url.includes("mzstatic.com")) {
        return new Response(FIXTURE_1500x2250, {
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

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("itunes");
    expect(p_row.cover_max_width).toBeGreaterThanOrEqual(1200);
    expect(p_row.storage_path).not.toBeNull();
  });

  it("GB + iTunes both miss premium; falls back to OL at basic floor", async () => {
    // GB: no imageLinks; iTunes: no results; OL cover_id present.
    // OL serves 600×900 — passes basic floor (300), fails premium (1200).
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olWithCoverResponse("12345"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL cover bytes — serve 600×900
      if (url.includes("covers.openlibrary.org")) {
        return new Response(FIXTURE_600x900, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB — no imageLinks
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // iTunes — no results
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("openlibrary_isbn");
    // 600×900 fixture — width should be 600
    expect(p_row.cover_max_width).toBe(600);
    expect(p_row.storage_path).not.toBeNull();
  });

  it("all sources fail → negative cache (storage_path null, cover_source null)", async () => {
    // GB: no imageLinks; iTunes: no results; OL: cover_id present but bytes too
    // small to pass OL's minBytes (1024). Cover is null → negative-cache row.
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olWithCoverResponse("77777"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL cover — serve 143×218 fixture (only 410 bytes, below OL minBytes=1024)
      if (url.includes("covers.openlibrary.org")) {
        return new Response(FIXTURE_143x218, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB — no imageLinks
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // iTunes — no results
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.storage_path).toBeNull();
    expect(p_row.cover_source).toBeNull();
    expect(p_row.cover_max_width).toBeNull();
    expect(p_row.last_attempted_at).toBeTruthy();
    expect(p_row.attempt_count).toBeGreaterThan(0);
  });

  it("rate-limited GB skips to iTunes; iTunes resolves", async () => {
    // GB limiter denies → tryGoogleBooksExtraLarge returns null immediately.
    // iTunes returns 1500×2250.
    const supabase = coldMissSupabase();
    const ITUNES_URL =
      "https://is2-ssl.mzstatic.com/image/thumb/Books/bar/100x100bb.jpg";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(itunesResponse(ITUNES_URL), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("mzstatic.com")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const d = deps({
      fetchFn,
      rateLimiters: {
        openLibrary: { limit: vi.fn(async () => ({ success: true }) as never) },
        googleBooks: {
          limit: vi.fn(async () => ({ success: false }) as never),
        },
        itunes: { limit: vi.fn(async () => ({ success: true }) as never) },
      },
    });

    await resolveIsbn(supabase as never, "9780743273565", d);

    // GB JSON should not have been fetched (limiter denied)
    const gbCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("googleapis.com"),
    );
    expect(gbCalls).toHaveLength(0);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("itunes");
    expect(p_row.cover_max_width).toBeGreaterThanOrEqual(1200);
  });

  it("description fallback fires when OL description absent and GB has one", async () => {
    // OL data: no description; GB has description text. Cover from OL (basic tier).
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olWithCoverResponse("12345"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("covers.openlibrary.org")) {
        return new Response(FIXTURE_600x900, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB — no imageLinks but has description for description fallback
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            {}, // no imageLinks
            { description: "A story about the American dream." },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    // Description came from GB
    expect(typeof p_row.description).toBe("string");
    expect(p_row.description).not.toBeNull();
    // Cover came from OL (GB had no imageLinks)
    expect(p_row.cover_source).toBe("openlibrary_isbn");
  });
});

describe("resolveTitleAuthor – resolver chain", () => {
  it("title/author: OL search finds cover_i; chain resolves via OL when GB has no imageLinks", async () => {
    // resolveTitleAuthor; GB has no imageLinks; iTunes skipped (no isbn);
    // OL cover_i from search result; OL -L returns 600×900.
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null },
      { data: null, error: null }, // selectBySha dedup
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL search by title/author — returns cover_i
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            numFound: 1,
            docs: [
              {
                key: "/works/OL12345W",
                title: "The Great Gatsby",
                author_name: ["F. Scott Fitzgerald"],
                cover_i: 9876,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("covers.openlibrary.org")) {
        return new Response(FIXTURE_600x900, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB — no imageLinks
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_title_author",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("openlibrary_search_title");
    expect(p_row.cover_max_width).toBe(600);

    // iTunes should never be called (no ISBN in title/author flow)
    const itunesCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("itunes.apple.com"),
    );
    expect(itunesCalls).toHaveLength(0);
  });
});

// ─── do_not_refetch_description flag ────────────────────────────────────────

describe("resolveIsbn – do_not_refetch_description", () => {
  // Existing row that is past the negative-cache TTL so the resolver runs,
  // but has the takedown flag set.
  function makeStaleRow(flag: boolean) {
    return staleNegativeRow({ do_not_refetch_description: flag });
  }

  it("honors flag: GB not called for description when do_not_refetch_description=true", async () => {
    // With the new flow, enrichDescriptionWithGoogleBooks short-circuits on
    // do_not_refetch_description=true — GB is not consulted at all for text.
    // GB IS still called as part of the cover chain; this test verifies
    // description remains null while the chain runs normally.
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(true)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const r = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );
    expect(r.row.description).toBeNull();
  });

  it("no flag: description populated from GB when do_not_refetch_description=false", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(false)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            {},
            { description: "A story about the American dream." },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(typeof p_row.description).toBe("string");
    expect(p_row.description).not.toBeNull();
  });

  it("flag: description null in upsert RPC payload even though GB was called for cover chain", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(true)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            {},
            { description: "Should NOT appear due to flag." },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.description).toBeNull();
  });

  it("flag set + GB cover wins → cover stored, description null", async () => {
    // GB has an extraLarge cover; takedown flag means description stays null.
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [makeStaleRow(true)], error: null },
      { data: null, error: null }, // selectBySha dedup
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const GB_URL = "https://books.google.com/books/content?id=xyz&img=1&zoom=0";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_URL },
            { description: "Marketing blurb to be ignored." },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // GB cover image
      if (url.includes("books.google.com")) {
        return new Response(FIXTURE_1500x2250, {
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

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    // Flag respected: description still null
    expect(p_row.description).toBeNull();
    // Cover came from GB
    expect(p_row.storage_path).not.toBeNull();
    expect(p_row.cover_source).toBe("google_books");
  });

  it("flag set + GB wins → OL cover URL not fetched", async () => {
    // GB has extraLarge cover. OL has a cover_id. GB wins first in the chain,
    // so OL cover bytes should NOT be fetched.
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [makeStaleRow(true)], error: null },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const OL_COVER_URL = "https://covers.openlibrary.org/b/id/12345-L.jpg";
    const GB_COVER_URL =
      "https://books.google.com/books/content?id=abc&img=1&zoom=0";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olWithCoverResponse("12345"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL cover bytes — should NOT be reached
      if (url.includes("covers.openlibrary.org")) {
        return new Response(FIXTURE_600x900, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse({ extraLarge: GB_COVER_URL }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // GB cover
      if (url.includes("books.google.com/books/content")) {
        return new Response(FIXTURE_1500x2250, {
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

    // OL cover URL was NOT fetched (GB won first in chain)
    const olCoverCalls = (
      fetchFn as ReturnType<typeof vi.fn>
    ).mock.calls.filter((args: unknown[]) =>
      String(args[0]).startsWith(OL_COVER_URL),
    );
    expect(olCoverCalls).toHaveLength(0);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.description).toBeNull();
    expect(p_row.cover_source).toBe("google_books");
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

  it("honors flag: description not applied when do_not_refetch_description=true", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [makeStaleRow(true)],
      error: null,
    });
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            {},
            { description: "A story about the American dream." },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const r = await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      deps({ fetchFn }),
    );
    expect(r.row.description).toBeNull();
  });

  it("flag set + no OL cover → GB cover fallback applied (description still null)", async () => {
    // The do_not_refetch_description flag must gate description text only —
    // GB cover chain runs regardless. Regression guard for the old
    // enrichWithGoogleBooks helper pattern.
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [makeStaleRow(true)], error: null },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });

    const GB_COVER_URL =
      "https://books.google.com/books/content?id=zzz&img=1&zoom=0";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/search.json")) {
        // No OL cover available
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_COVER_URL },
            { description: "Marketing blurb to be ignored." },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("books.google.com")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_title_author",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;

    // Flag respected: description still null
    expect(p_row.description).toBeNull();
    // Cover came from GB chain even with flag set
    expect(p_row.storage_path).not.toBeNull();
    expect(p_row.cover_source).toBe("google_books");
  });
});

// ─── selectBySha dedup error handling ────────────────────────────────────────

describe("resolveIsbn – selectBySha dedup", () => {
  it("selectBySha throws when supabase returns DB error", async () => {
    const supabase = createMockSupabase();
    // Queue two book_catalog.select results:
    //   1st → selectByIsbn: no existing row (miss, resolver proceeds)
    //   2nd → selectBySha: DB error (should throw, not silently return null)
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null },
      { data: null, error: { message: "transient db error" } },
    ]);

    // Provide a GB cover (first in chain) so persistCover is reached.
    // GB serves the 1500×2250 fixture so decodeImageDimensions succeeds.
    const GB_COVER_URL =
      "https://books.google.com/books/content?id=err&img=1&zoom=0";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse({ extraLarge: GB_COVER_URL }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.apple.com/lookup")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // GB cover — serve 1500×2250 so it passes all floors
      if (url.includes("books.google.com")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await expect(
      resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn })),
    ).rejects.toThrow(/selectBySha/);
  });
});
