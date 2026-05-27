import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createMockSupabase } from "../../helpers";
import {
  __setTestDestination,
  __resetTestDestination,
} from "../../../src/lib/server/log";

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

// Sentry SDK is invoked from `resolveIsbn` / `resolveTitleAuthor` for the
// suspect-cover signal (Task 10). Stub the module so tests can assert
// against the captureMessage spy without booting the real client. The
// spy is created via `vi.hoisted` so it's available inside the hoisted
// `vi.mock` factory (top-level variables aren't, since the factory
// executes before module top-level code).
const { sentryCaptureMessage } = vi.hoisted(() => ({
  sentryCaptureMessage: vi.fn(() => "fake-event-id"),
}));
vi.mock("@sentry/sveltekit", () => ({
  captureMessage: sentryCaptureMessage,
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));

import {
  resolveIsbn,
  resolveTitleAuthor,
} from "../../../src/lib/server/catalog/fetcher";
import { noopMutex } from "../../../src/lib/server/catalog/mutex";

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
// 250×375 — passes salvage floor (240) but fails basic floor (300). Used
// to validate the third-pass tier added in refit 2026-05-27.
const FIXTURE_250x375 = loadFixture("250x375.jpg");
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
    // googleBooksApiKey present so the walker's GB legs aren't gated as
    // `disabled` (refit 2026-05-27). Tests asserting the no-key path
    // should override to undefined explicitly.
    googleBooksApiKey: "test-api-key",
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

/**
 * Returns a ResolveDeps where every upstream call fails harmlessly so
 * tests can assert on the cache-hit guard without running a real resolve.
 * Rate limiters deny → the resolver bails with rateLimited:true after the
 * cache-hit check passes, which is fine: assertions only test `cached`.
 */
function makeDepsWithAllUpstreamFailing() {
  return deps({
    fetchFn: vi.fn(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch,
    rateLimiters: denyAll(),
    mutex: noopMutex,
  });
}

/** Stale row: past the 90-day per-field TTL for provider_no_data. */
function staleNegativeRow(extra: Record<string, unknown> = {}) {
  // 100 days before "now" (2026-05-02) → exceeds the 90-day TTL for
  // provider_no_data / exhausted; every field is due for re-attempt.
  const stale = "2026-01-22T00:00:00Z";
  return {
    isbn: "9780743273565",
    storage_path: null,
    description: null,
    publisher: null,
    published_date: null,
    subjects: null,
    page_count: null,
    last_attempted_at: stale,
    attempt_count: 1,
    cover_attempted_at: stale,
    cover_fail_reason: "provider_no_data",
    description_attempted_at: stale,
    description_fail_reason: "provider_no_data",
    publisher_attempted_at: stale,
    publisher_fail_reason: "provider_no_data",
    published_date_attempted_at: stale,
    published_date_fail_reason: "provider_no_data",
    subjects_attempted_at: stale,
    subjects_fail_reason: "provider_no_data",
    page_count_attempted_at: stale,
    page_count_fail_reason: "provider_no_data",
    ...extra,
  };
}

/**
 * Fully-cached row: every tracked field populated. shouldAttempt returns
 * false for every field; cache short-circuit returns cached=true without
 * any upstream calls. Refit 2026-05-27.
 */
function fullyCachedRow(extra: Record<string, unknown> = {}) {
  return {
    isbn: "9780743273565",
    storage_path: "x/y.jpg",
    cover_storage_backend: "supabase",
    title: "Gatsby",
    description: "filled",
    publisher: "filled",
    published_date: "2020",
    subjects: ["fiction"],
    page_count: 200,
    ...extra,
  };
}

/**
 * Fresh-negative row: cover null + every tracked field fail_reason set
 * within the 90-day TTL window. shouldAttempt returns false for every
 * field; cache short-circuit returns cached=true.
 */
function freshNegativeRow(
  isbn = "9780000000026",
  extra: Record<string, unknown> = {},
) {
  const recent = "2026-04-25T00:00:00Z"; // 7 days before fixture "now"
  return {
    isbn,
    storage_path: null,
    description: null,
    publisher: null,
    published_date: null,
    subjects: null,
    page_count: null,
    pending_storage: false,
    last_attempted_at: recent,
    attempt_count: 1,
    cover_attempted_at: recent,
    cover_fail_reason: "provider_no_data",
    description_attempted_at: recent,
    description_fail_reason: "provider_no_data",
    publisher_attempted_at: recent,
    publisher_fail_reason: "provider_no_data",
    published_date_attempted_at: recent,
    published_date_fail_reason: "provider_no_data",
    subjects_attempted_at: recent,
    subjects_fail_reason: "provider_no_data",
    page_count_attempted_at: recent,
    page_count_fail_reason: "provider_no_data",
    ...extra,
  };
}

/** Build a GB volumes JSON response with the given imageLinks.
 *
 * `extra` is spread INTO `volumeInfo` (alongside title, imageLinks).
 * `accessInfo` is a sibling of `volumeInfo` at the item root — passed
 * separately so tests can opt into the Task 8 pdf.isAvailable filter.
 * Tests that pass `accessInfo: { pdf: { isAvailable: true } }` are
 * asserting GB-wins behavior; absent `accessInfo` triggers the filter
 * and the chain falls through. See Task 8 / issue #209. */
function gbVolumesResponse(
  imageLinks: Record<string, string> = {},
  extra: Record<string, unknown> = {},
  accessInfo?: Record<string, unknown>,
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
        ...(accessInfo ? { accessInfo } : {}),
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
      data: [fullyCachedRow()],
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
      data: [freshNegativeRow("9780743273565")],
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
      data: [staleNegativeRow()],
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

  it("treats pending_storage=TRUE row as a miss and proceeds to resolve", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: "9780000000019",
          storage_path: null,
          pending_storage: true,
          last_attempted_at: new Date().toISOString(),
          attempt_count: 1,
        },
      ],
      error: null,
    });

    const d = makeDepsWithAllUpstreamFailing();

    const result = await resolveIsbn(supabase as never, "9780000000019", d);

    expect(result.cached).toBe(false);
  });

  it("still short-circuits on non-pending fresh-negative row", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [freshNegativeRow("9780000000026")],
      error: null,
    });

    const d = makeDepsWithAllUpstreamFailing();

    const result = await resolveIsbn(supabase as never, "9780000000026", d);

    expect(result.cached).toBe(true);
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
        fullyCachedRow({
          isbn: null,
          normalized_title_author: "the great gatsby|f scott fitzgerald",
        }),
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

  it("treats pending_storage=TRUE row as a miss and proceeds to resolve", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: null,
          normalized_title_author: "synth title|synth author",
          storage_path: null,
          pending_storage: true,
          last_attempted_at: new Date().toISOString(),
          attempt_count: 1,
        },
      ],
      error: null,
    });

    const d = makeDepsWithAllUpstreamFailing();

    const result = await resolveTitleAuthor(
      supabase as never,
      "Synth Title",
      "Synth Author",
      d,
    );

    expect(result.cached).toBe(false);
  });

  it("still short-circuits on non-pending fresh-negative title/author row", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        freshNegativeRow(undefined, {
          isbn: null,
          normalized_title_author: "synth title|synth author",
        }),
      ],
      error: null,
    });

    const d = makeDepsWithAllUpstreamFailing();

    const result = await resolveTitleAuthor(
      supabase as never,
      "Synth Title",
      "Synth Author",
      d,
    );

    expect(result.cached).toBe(true);
  });

  // ── Task 4 reorder invariant tests ─────────────────────────────────────────

  /** Standard supabase setup for a cold-miss resolveTitleAuthor resolve. */
  function coldMissTaSupabase() {
    const supabase = createMockSupabase();
    // 1st select → initial book_catalog lookup (miss); 2nd → selectBySha (no dedup)
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });
    // Finalize step is a plain UPDATE keyed on (isbn IS NULL AND
    // normalized_title_author = key). Mock returns success.
    supabase._results.set("book_catalog.update", { data: null, error: null });
    return supabase;
  }

  it("writes pending_storage=true on initial upsert, then finalizes with pending_storage=false (title/author)", async () => {
    // Verifies the two-step write contract for the title/author resolver:
    // RPC upsert carries pending_storage=TRUE with storage fields null;
    // finalize UPDATE carries pending_storage=FALSE with storage fields
    // populated. Mirrors the resolveIsbn invariant from Task 3.
    // See spec 2026-05-18-catalog-cover-upload-ordering-design.
    const supabase = coldMissTaSupabase();
    const GB_URL =
      "https://books.google.com/books/content?id=ta1&printsec=frontcover&img=1&zoom=0";
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
            { extraLarge: GB_URL },
            {},
            { pdf: { isAvailable: true } },
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

    const result = await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      deps({ fetchFn }),
    );

    // The initial RPC call must carry pending_storage=true and storage_path=null.
    const rpcCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_title_author",
    );
    expect(rpcCall).toBeDefined();
    const p_row = (rpcCall!.args as { p_row: Record<string, unknown> }).p_row;
    expect(p_row.pending_storage).toBe(true);
    expect(p_row.storage_path).toBeNull();
    expect(p_row.cover_max_width).toBeNull();

    // The finalize UPDATE must carry pending_storage=false with storage fields.
    expect(supabase._updateCalls).toHaveLength(1);
    expect(supabase._updateCalls[0].table).toBe("book_catalog");
    const updatePayload = supabase._updateCalls[0].payload as Record<
      string,
      unknown
    >;
    expect(updatePayload.pending_storage).toBe(false);
    expect(updatePayload.storage_path).not.toBeNull();

    // Result row reflects the finalized state.
    expect(result.row.pending_storage).toBe(false);
    expect(result.row.storage_path).not.toBeNull();
  });

  it("leaves pending row and skips finalize when upload throws (title/author)", async () => {
    // Verifies that a failed upload leaves the row pending (RPC was called)
    // but does NOT call the finalize UPDATE. The pending row stays in place
    // for the next feed render to retry. Mirrors the resolveIsbn invariant
    // from Task 3.
    const supabase = coldMissTaSupabase();
    const GB_URL =
      "https://books.google.com/books/content?id=ta2&printsec=frontcover&img=1&zoom=0";
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
            { extraLarge: GB_URL },
            {},
            { pdf: { isAvailable: true } },
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

    const d = deps({
      fetchFn,
      coverStorage: {
        uploadCover: vi.fn(async () => {
          throw new Error("synthetic upload failure");
        }),
      },
    });

    await expect(
      resolveTitleAuthor(
        supabase as never,
        "The Great Gatsby",
        "F. Scott Fitzgerald",
        d,
      ),
    ).rejects.toThrow(/synthetic upload failure/);

    // RPC was called (pending row written with pending_storage=true).
    const rpcCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_title_author",
    );
    expect(rpcCall).toBeDefined();
    const p_row = (rpcCall!.args as { p_row: Record<string, unknown> }).p_row;
    expect(p_row.pending_storage).toBe(true);

    // UPDATE was NOT called — finalize never ran because upload threw.
    expect(supabase._updateCalls).toHaveLength(0);
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
    // After Task 3 reorder: finalize step is a plain UPDATE on book_catalog
    // keyed on isbn. Mock returns success so the cover branch completes.
    supabase._results.set("book_catalog.update", {
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
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_URL },
            {},
            { pdf: { isAvailable: true } },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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

    const result = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("google_books");
    // After Task 3 reorder: initial RPC row has storage_path=NULL;
    // finalize UPDATE writes the storage fields. Assert on result.row.
    expect(p_row.storage_path).toBeNull();
    expect(result.row.cover_max_width).toBeGreaterThanOrEqual(1200);
    expect(result.row.storage_path).not.toBeNull();

    // iTunes cover bytes endpoint should not have been called — GB won
    // the cover chain at premium tier. Refit 2026-05-27 added an iTunes
    // description leg that DOES call the lookup endpoint when GB/OL
    // didn't supply description, so we filter the cover-bytes host
    // separately rather than asserting against the iTunes API root.
    const itunesCoverBytesCalls = (
      fetchFn as ReturnType<typeof vi.fn>
    ).mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes("mzstatic.com"),
    );
    expect(itunesCoverBytesCalls).toHaveLength(0);
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

    const result = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("itunes");
    // After Task 3 reorder: initial RPC row has storage_path=NULL;
    // finalize UPDATE writes the storage fields. Assert on result.row.
    expect(p_row.storage_path).toBeNull();
    expect(result.row.cover_max_width).toBeGreaterThanOrEqual(1200);
    expect(result.row.storage_path).not.toBeNull();
  });

  it("GB + iTunes both miss premium; falls back to OL at basic floor", async () => {
    // GB: no imageLinks; iTunes: no results; OL cover_id present.
    // OL serves 600×900 — passes basic floor (300), fails premium (1200).
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL direct-ISBN tier (Task 6) probes first — return 404 so this test
      // continues to assert the openlibrary_isbn (by cover_id) path.
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
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

    const result = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("openlibrary_isbn");
    // After Task 3 reorder: initial RPC row has storage_path=NULL and
    // cover_max_width=NULL; finalize UPDATE writes the storage fields.
    expect(p_row.storage_path).toBeNull();
    expect(p_row.cover_max_width).toBeNull();
    // 600×900 fixture — width should be 600; assert on result.row.
    expect(result.row.cover_max_width).toBe(600);
    expect(result.row.storage_path).not.toBeNull();
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
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
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

  it("accepts a 250 px cover via salvage tier when basic+premium both fail", async () => {
    // OL direct-ISBN returns 250×375 bytes — below basic floor (300) but
    // above salvage floor (240). Three-pass tiering enabled by refit
    // 2026-05-27 should pick this up on the salvage pass after the
    // first two passes reject it.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(FIXTURE_250x375, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
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
        return new Response(gbVolumesResponse(), {
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

    const result = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    expect(result.row.cover_source).toBe("openlibrary_isbn_direct");
    expect(result.row.cover_max_width).toBe(250);
    expect(result.row.storage_path).not.toBeNull();
  });

  it("rejects a 200 px cover below salvage floor → negative-cache", async () => {
    // 200×300 source bytes are below the 240 salvage floor; every tier
    // rejects → cover === null → negative-cache row with no
    // storage_path.
    const supabase = coldMissSupabase();
    const FIXTURE_200x300 = loadFixture("200x300.jpg");
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(FIXTURE_200x300, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
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
        return new Response(gbVolumesResponse(), {
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

    const result = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    expect(result.row.storage_path).toBeNull();
    expect(result.row.cover_source).toBeNull();
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

    const result = await resolveIsbn(supabase as never, "9780743273565", d);

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
    // After Task 3 reorder: cover_max_width is null in the initial RPC row;
    // finalize UPDATE writes it. Assert on result.row.
    expect(p_row.cover_max_width).toBeNull();
    expect(result.row.cover_max_width).toBeGreaterThanOrEqual(1200);
  });

  it("description fallback fires when OL description absent and GB has one", async () => {
    // OL data: no description; GB has description text. Cover from OL (basic tier).
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL direct-ISBN tier (Task 6) probes first — return 404 so this test
      // continues to assert the openlibrary_isbn (by cover_id) path.
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
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

  it("OL direct-ISBN returns bytes → tier 1 wins; GB never called", async () => {
    // Cold-miss for an ISBN where OL's covers/b/isbn/ endpoint returns a real
    // cover. New tier (Task 6) puts this first. GB JSON may or may not be
    // fetched (the OL chain context discovery still runs); the assertion is
    // that the GB COVER BYTES are not fetched, and the winning cover_source
    // is openlibrary_isbn_direct.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL direct ISBN endpoint — returns a real 1500x2250 cover.
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // OL data document — no cover info, just title metadata.
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL search — no results.
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
      // GB metadata — present and filter-passing so the test demonstrates
      // ordering (OL beats GB on priority), not GB being filtered out.
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            {
              extraLarge: "https://books.google.com/should-not-be-fetched.jpg",
            },
            {},
            { pdf: { isAvailable: true } },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.startsWith("https://books.google.com/")) {
        throw new Error("GB cover URL must not be fetched when OL direct wins");
      }
      if (url.includes("itunes.apple.com")) {
        throw new Error("iTunes must not be called when OL direct wins");
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const result = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.cover_source).toBe("openlibrary_isbn_direct");
    // After Task 3 reorder: cover_max_width null in initial RPC row.
    expect(p_row.cover_max_width).toBeNull();
    expect(result.row.cover_max_width).toBeGreaterThanOrEqual(1200);
  });

  it("OL by cover_id wins over GB when both have valid bytes at the same floor", async () => {
    // Pre-reorder: GB extraLarge wins because GB is checked before tryOpenLibrary.
    // Post-reorder (this task): tryOpenLibrary (cover_id) is checked before GB,
    // so the OL `b/id/` cover wins when both sources offer valid premium bytes.
    // OL direct returns 404 (no isbn-keyed cover) so the second tier (OL cover_id) gets to win.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL direct ISBN — 404 so it does not short-circuit the test.
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
      // OL data document — empty (no embedded cover URL).
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL search — returns a cover_id so tryOpenLibrary has a target.
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({ numFound: 1, docs: [{ cover_i: 12345 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL cover_id endpoint — returns a real 1500x2250 cover.
      if (url.includes("covers.openlibrary.org/b/id/12345")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB also offers a premium cover with valid bytes and a filter-passing
      // accessInfo — pre-reorder this would win (GB checked before
      // tryOpenLibrary); post-reorder it loses to OL cover_id because
      // tryOpenLibrary runs first. accessInfo.pdf.isAvailable=true ensures
      // the Task 8 filter does NOT reject GB — the test must demonstrate
      // ordering, not filter behavior.
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            {
              extraLarge: "https://books.google.com/gb-premium-cover.jpg",
            },
            {},
            { pdf: { isAvailable: true } },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://books.google.com/")) {
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
    expect(p_row.cover_source).toBe("openlibrary_isbn");
  });

  it("rejects GB cover when accessInfo.pdf.isAvailable=false; chain advances to iTunes", async () => {
    // Apple-in-China-style fixture: GB has full imageLinks tier (extraLarge
    // present) BUT pdf.isAvailable=false → discriminator says no real cover
    // scan exists → reject. Chain falls through to iTunes (which we mock
    // to win) so we can verify GB was not the source.
    const supabase = coldMissSupabase();
    const ITUNES_URL =
      "https://is1-ssl.mzstatic.com/image/thumb/Music/foo/100x100bb.jpg";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/")) {
        return new Response(null, { status: 404 });
      }
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
        // GB has full imageLinks (extraLarge present) but accessInfo.pdf.isAvailable=false.
        return new Response(
          JSON.stringify({
            kind: "books#volumes",
            totalItems: 1,
            items: [
              {
                id: "gbid1",
                volumeInfo: {
                  title: "X",
                  imageLinks: {
                    extraLarge: "https://books.google.com/extra.jpg",
                  },
                },
                accessInfo: {
                  pdf: { isAvailable: false },
                  viewability: "PARTIAL",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://books.google.com/")) {
        throw new Error(
          "GB cover URL must not be fetched when pdf.isAvailable=false",
        );
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

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    // GB was rejected; chain fell through to iTunes.
    expect(p_row.cover_source).toBe("itunes");
  });

  it("accepts GB cover when accessInfo.pdf.isAvailable=true", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/")) {
        return new Response(null, { status: 404 });
      }
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
          JSON.stringify({
            kind: "books#volumes",
            totalItems: 1,
            items: [
              {
                id: "gbid1",
                volumeInfo: {
                  title: "X",
                  imageLinks: {
                    extraLarge: "https://books.google.com/extra.jpg",
                  },
                },
                accessInfo: {
                  pdf: { isAvailable: true },
                  viewability: "PARTIAL",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://books.google.com/")) {
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
  });

  it("populates audit fields on accepted GB cover", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/")) {
        return new Response(null, { status: 404 });
      }
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
            {
              extraLarge: "https://books.google.com/extra.jpg",
              large: "https://books.google.com/large.jpg",
            },
            {},
            { pdf: { isAvailable: true }, viewability: "PARTIAL" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.startsWith("https://books.google.com/")) {
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
    expect(p_row.gb_pdf_available).toBe(true);
    expect(p_row.gb_viewability).toBe("PARTIAL");
    expect(p_row.gb_image_link_tiers).toEqual(["extraLarge", "large"]);
    expect(p_row.cover_aspect).toBeCloseTo(2250 / 1500, 3);
    expect(typeof p_row.cover_bytes_per_pixel).toBe("number");
    expect(p_row.cover_bytes_per_pixel).toBeGreaterThan(0);
  });

  it("populates GB audit fields even when GB is filtered (rejected_no_pdf, OL direct wins)", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
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
        // GB volume fetched (by description-enrichment path), but pdf.isAvailable=false.
        return new Response(
          gbVolumesResponse(
            { extraLarge: "https://books.google.com/extra.jpg" },
            {},
            { pdf: { isAvailable: false }, viewability: "PARTIAL" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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
    // OL direct wins because GB is filtered out.
    expect(p_row.cover_source).toBe("openlibrary_isbn_direct");
    // GB metadata still captured.
    expect(p_row.gb_pdf_available).toBe(false);
    expect(p_row.gb_image_link_tiers).toEqual(["extraLarge"]);
  });

  // ── Task 3 reorder invariant tests ─────────────────────────────────────────

  it("writes pending_storage=true on initial upsert, then finalizes with pending_storage=false", async () => {
    // Verifies the two-step write contract: RPC upsert carries pending_storage=TRUE
    // with storage fields null; finalize UPDATE carries pending_storage=FALSE with
    // storage fields populated. See spec 2026-05-18-catalog-cover-upload-ordering-design.
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
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_URL },
            {},
            { pdf: { isAvailable: true } },
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

    const result = await resolveIsbn(
      supabase as never,
      "9780000000019",
      deps({ fetchFn }),
    );

    // The initial RPC call must carry pending_storage=true and storage_path=null.
    const rpcCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(rpcCall).toBeDefined();
    const p_row = (rpcCall!.args as { p_row: Record<string, unknown> }).p_row;
    expect(p_row.pending_storage).toBe(true);
    expect(p_row.storage_path).toBeNull();
    expect(p_row.cover_max_width).toBeNull();

    // The finalize UPDATE must carry pending_storage=false with storage fields.
    expect(supabase._updateCalls).toHaveLength(1);
    expect(supabase._updateCalls[0].table).toBe("book_catalog");
    const updatePayload = supabase._updateCalls[0].payload as Record<
      string,
      unknown
    >;
    expect(updatePayload.pending_storage).toBe(false);
    expect(updatePayload.storage_path).not.toBeNull();

    // Result row reflects the finalized state.
    expect(result.row.pending_storage).toBe(false);
    expect(result.row.storage_path).not.toBeNull();
  });

  it("leaves pending row and skips finalize when upload throws", async () => {
    // Verifies that a failed upload leaves the row pending (RPC was called)
    // but does NOT call the finalize UPDATE. The pending row stays in place
    // for the next feed render to retry.
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
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_URL },
            {},
            { pdf: { isAvailable: true } },
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

    const d = deps({
      fetchFn,
      coverStorage: {
        uploadCover: vi.fn(async () => {
          throw new Error("synthetic upload failure");
        }),
      },
    });

    await expect(
      resolveIsbn(supabase as never, "9780000000026", d),
    ).rejects.toThrow(/synthetic upload failure/);

    // RPC was called (pending row written with pending_storage=true).
    const rpcCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(rpcCall).toBeDefined();
    const p_row = (rpcCall!.args as { p_row: Record<string, unknown> }).p_row;
    expect(p_row.pending_storage).toBe(true);

    // UPDATE was NOT called — finalize never ran because upload threw.
    expect(supabase._updateCalls).toHaveLength(0);
  });

  it("throws book_catalog storage finalize when UPDATE fails after upload", async () => {
    // Cold-miss resolve where the finalize UPDATE step returns a DB error.
    // Verifies that: (1) the error message is distinguishable ("book_catalog
    // storage finalize"), (2) the RPC was called with pending_storage=TRUE
    // (initial upsert succeeded), and (3) the UPDATE was attempted exactly
    // once. The pending row stays in the DB for the next feed render's
    // recovery path (cache-hit bypass → re-resolve → upload → finalize retry).
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null }, // selectByIsbn miss
      { data: null, error: null }, // selectBySha miss
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });
    supabase._results.set("book_catalog.update", {
      data: null,
      error: { message: "synthetic db update failure" },
    });

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
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_URL },
            {},
            { pdf: { isAvailable: true } },
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

    const d = deps({ fetchFn });

    await expect(
      resolveIsbn(supabase as never, "9780000000033", d),
    ).rejects.toThrow(/book_catalog storage finalize/);

    // RPC was called with pending_storage=true (initial upsert succeeded).
    const rpcCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(rpcCall).toBeDefined();
    const p_row = (rpcCall!.args as { p_row: Record<string, unknown> }).p_row;
    expect(p_row.pending_storage).toBe(true);

    // UPDATE was attempted exactly once (upload succeeded, finalize threw).
    expect(supabase._updateCalls).toHaveLength(1);
  });

  // Defense-in-depth: OpenLibrary work IDs returned by the upstream JSON
  // response are interpolated directly into the work-fetch URL. The expected
  // shape is `OL\d+W`. A malformed value (path-traversal-like or anything
  // outside the canonical shape) must skip the work fetch entirely — not
  // hit the URL with sanitisation-by-luck (issue #253).
  it("skips fetchOpenLibraryWork when OL returns a malformed works[0].key", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        // ISBN lookup returns a work key that fails the OL\d+W shape check.
        // Without the guard this would be interpolated into
        // /works/garbage%2F..%2Fadmin.json verbatim.
        return new Response(
          JSON.stringify({
            "ISBN:9780743273565": {
              title: "Foo",
              works: [{ key: "/works/garbage/..%2F..%2Fadmin" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.apple.com")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(0), { status: 404 });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const fetchedUrls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => String(args[0]),
    );
    // The malformed work key must NOT have triggered a /works/<id>.json call.
    expect(fetchedUrls.some((u) => u.includes("openlibrary.org/works/"))).toBe(
      false,
    );
  });
});

describe("resolveTitleAuthor – resolver chain", () => {
  it("title/author: OL search finds cover_i; chain resolves via OL when GB has no imageLinks", async () => {
    // resolveTitleAuthor; GB has no imageLinks; iTunes skipped (no isbn);
    // OL cover_i from search result; OL -L returns 600×900.
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null },
      { data: null, error: null }, // selectBySha dedup
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });
    // After Task 4 reorder: finalize step is a plain UPDATE on book_catalog
    // keyed on (isbn IS NULL AND normalized_title_author = key).
    supabase._results.set("book_catalog.update", { data: null, error: null });

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

    const result = await resolveTitleAuthor(
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
    // After Task 4 reorder: cover_max_width is null in the pending RPC row;
    // it is written by the finalize UPDATE and reflected in result.row.
    expect(p_row.cover_max_width).toBeNull();
    expect(result.row.cover_max_width).toBe(600);

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
    // Task 3 reorder: finalize UPDATE needed when a cover is found.
    supabase._results.set("book_catalog.update", { data: null, error: null });

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
            { pdf: { isAvailable: true } },
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

    const result = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    // Flag respected: description still null
    expect(p_row.description).toBeNull();
    // Cover came from GB; after Task 3 reorder storage_path is null in
    // the initial RPC row — assert on result.row for the post-finalize state.
    expect(p_row.storage_path).toBeNull();
    expect(p_row.cover_source).toBe("google_books");
    expect(result.row.storage_path).not.toBeNull();
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
    // Task 3 reorder: finalize UPDATE needed when a cover is found.
    supabase._results.set("book_catalog.update", { data: null, error: null });

    const GB_COVER_URL =
      "https://books.google.com/books/content?id=abc&img=1&zoom=0";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL cover endpoints (both direct-ISBN and cover_id) — 404 so the chain
      // falls through to GB; otherwise post-reorder OL would win first.
      if (url.includes("covers.openlibrary.org/b/")) {
        return new Response(null, { status: 404 });
      }
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
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_COVER_URL },
            {},
            { pdf: { isAvailable: true } },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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

    // OL cover URLs return 404 in this fixture, so the chain falls through
    // to GB. Asserting `cover_source === "google_books"` is the real
    // invariant — GB's bytes were used, OL's were not (regardless of
    // whether the chain probed OL endpoints first under the precision-
    // first reorder).
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
    // After Task 4 reorder: finalize step is a plain UPDATE.
    supabase._results.set("book_catalog.update", { data: null, error: null });

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
            { pdf: { isAvailable: true } },
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

    const result = await resolveTitleAuthor(
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
    // After Task 4 reorder: storage_path is null in the pending RPC row;
    // it is written by the finalize UPDATE and reflected in result.row.
    expect(p_row.storage_path).toBeNull();
    // Cover came from GB chain even with flag set — reflected in result.row
    expect(result.row.storage_path).not.toBeNull();
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
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_COVER_URL },
            {},
            { pdf: { isAvailable: true } },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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

// ─── #203: GoogleBooks volume reuse across cover chain + description ─────────

describe("resolveIsbn – GB volume reuse (#203)", () => {
  function coldMissSupabase() {
    const supabase = createMockSupabase();
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

  function gbBothCoverAndDescription() {
    const GB_URL =
      "https://books.google.com/books/content?id=hailmary&img=1&zoom=0";
    return vi.fn(async (input: URL | RequestInfo) => {
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
            { description: "A scientist wakes up alone on a spaceship." },
            { pdf: { isAvailable: true } },
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
  }

  it("fetches the GB volume only once when cover and description both need it", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = gbBothCoverAndDescription();
    const d = deps({ fetchFn });

    await resolveIsbn(supabase as never, "9780593135228", d);

    const gbCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("googleapis.com/books"),
    );
    expect(gbCalls).toHaveLength(1);
  });

  it("consumes the GB rate-limit token only once per resolve", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = gbBothCoverAndDescription();
    const d = deps({ fetchFn });

    await resolveIsbn(supabase as never, "9780593135228", d);

    expect(d.rateLimiters.googleBooks.limit).toHaveBeenCalledTimes(1);
  });

  it("still populates description from the reused GB volume", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = gbBothCoverAndDescription();
    const d = deps({ fetchFn });

    await resolveIsbn(supabase as never, "9780593135228", d);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.description_provider).toBe("google_books");
    expect(typeof p_row.description).toBe("string");
    expect((p_row.description as string).length).toBeGreaterThan(0);
    expect(p_row.cover_source).toBe("google_books");
  });

  it("description path still tries when cover-chain GB was rate-limited", async () => {
    // Edge case from issue #203: tryAcquire fails for the first attempt,
    // memo stays unset, description path's own attempt is allowed.
    // Limiter denies the first call only; the second succeeds.
    const supabase = coldMissSupabase();
    let limitCallNo = 0;
    const googleBooks = {
      limit: vi.fn(async () => {
        limitCallNo += 1;
        return { success: limitCallNo > 1 } as never;
      }),
    };
    const fetchFn = gbBothCoverAndDescription();
    const d = deps({
      fetchFn,
      rateLimiters: {
        openLibrary: { limit: vi.fn(async () => ({ success: true }) as never) },
        googleBooks,
        itunes: { limit: vi.fn(async () => ({ success: true }) as never) },
      },
    });

    await resolveIsbn(supabase as never, "9780593135228", d);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    // Description filled in from the description-path's own GB attempt
    expect(p_row.description_provider).toBe("google_books");
    // Two GB tokens consumed (one rejected, one accepted)
    expect(googleBooks.limit).toHaveBeenCalledTimes(2);
  });
});

// ─── #207: GoogleBooks placeholder sha blacklist ────────────────────────────

describe("resolveIsbn – GB placeholder sha blacklist (#207)", () => {
  function coldMissSupabase() {
    const supabase = createMockSupabase();
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

  it("rejects a GB cover whose sha is on the placeholder blacklist; chain advances to iTunes", async () => {
    // GB serves the 1500×2250 fixture — we register its sha as a known
    // placeholder for this test, so the chain must reject the GB cover
    // and fall through to iTunes (which also serves 1500×2250).
    const { KNOWN_GB_PLACEHOLDER_SHAS } =
      await import("../../../src/lib/server/catalog/fetcher");
    const { sha256Hex } = await import("../../../src/lib/server/catalog/sha");
    const fixtureSha = await sha256Hex(FIXTURE_1500x2250);
    KNOWN_GB_PLACEHOLDER_SHAS.add(fixtureSha);

    try {
      const supabase = coldMissSupabase();
      const GB_URL =
        "https://books.google.com/books/content?id=ph&img=1&zoom=0";
      const ITUNES_URL =
        "https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg";
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
        if (url.includes("itunes.apple.com/lookup")) {
          return new Response(itunesResponse(ITUNES_URL), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("books.google.com")) {
          return new Response(FIXTURE_1500x2250, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
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

      await resolveIsbn(supabase as never, "9781250827005", deps({ fetchFn }));

      const upsertCall = supabase._rpcCalls.find(
        (c) => c.name === "upsert_book_catalog_by_isbn",
      );
      const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
        .p_row;
      expect(p_row.cover_source).toBe("itunes");
    } finally {
      KNOWN_GB_PLACEHOLDER_SHAS.delete(fixtureSha);
    }
  });

  it("ships with the known production placeholder sha pre-registered", async () => {
    const { KNOWN_GB_PLACEHOLDER_SHAS } =
      await import("../../../src/lib/server/catalog/fetcher");
    expect(
      KNOWN_GB_PLACEHOLDER_SHAS.has(
        "3efa8c43e5b4348f303a528c81adf435f0111ea752fe9f0f6241478b60987fa6",
      ),
    ).toBe(true);
  });
});

describe("resolveTitleAuthor – GB volume reuse (#203)", () => {
  function coldMissSupabase() {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });
    return supabase;
  }

  it("fetches the GB volume only once when cover and description both need it", async () => {
    const supabase = coldMissSupabase();
    const GB_URL =
      "https://books.google.com/books/content?id=gatsby&img=1&zoom=0";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            numFound: 1,
            docs: [{ title: "Gatsby", author_name: ["Fitzgerald"] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            { extraLarge: GB_URL },
            { description: "Jazz Age." },
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
    const d = deps({ fetchFn });

    await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      d,
    );

    const gbCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("googleapis.com/books"),
    );
    expect(gbCalls).toHaveLength(1);
    expect(d.rateLimiters.googleBooks.limit).toHaveBeenCalledTimes(1);
  });
});

// ─── #206: description-skip observability logs ──────────────────────────────

describe("enrichDescriptionWithGoogleBooks – skip-point logs (#206)", () => {
  let logWrites: Array<Record<string, unknown>>;

  beforeEach(() => {
    logWrites = [];
    __setTestDestination((line) => logWrites.push(JSON.parse(line)));
  });
  afterEach(() => __resetTestDestination());

  function coldMissSupabase(extra: Record<string, unknown> = {}) {
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      {
        data: [
          {
            isbn: "9780743273565",
            storage_path: null,
            last_attempted_at: "2026-03-01T00:00:00Z",
            attempt_count: 1,
            ...extra,
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
    return supabase;
  }

  function baseFetchFn(
    gbOverride: (url: string) => Response | null = () => null,
  ) {
    return vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      const gbResp = gbOverride(url);
      if (gbResp) return gbResp;
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
  }

  it("warns when do_not_refetch_description=true short-circuits enrichment", async () => {
    const supabase = coldMissSupabase({ do_not_refetch_description: true });
    const fetchFn = baseFetchFn((url) =>
      url.includes("googleapis.com/books")
        ? new Response(
            gbVolumesResponse({}, { description: "Should not be used." }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : null,
    );
    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    const skipLog = logWrites.find(
      (l) => l.event === "catalog_description_skipped_takedown_flag",
    );
    expect(skipLog).toBeDefined();
    expect(skipLog?.level).toBe("warn");
    expect(skipLog?.isbn).toBe("9780743273565");
  });

  // Removed (refit 2026-05-27): catalog_description_no_gb_volume +
  // catalog_description_gb_volume_no_description log events. The walker
  // surfaces the same signal via the `description_fail_reason` column
  // (provider_no_data / provider_empty_field) — the DB is the queryable
  // source of truth. The takedown-flag log above stays because that's
  // the only path the walker explicitly logs (carryover surprise per
  // issue #206).
});

describe("resolveIsbn – Sentry suspect-cover warning (Task 10)", () => {
  function coldMissSupabase() {
    const supabase = createMockSupabase();
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

  beforeEach(() => sentryCaptureMessage.mockClear());

  it("captures Sentry warning when accepted GB cover has cover_bytes_per_pixel < threshold", async () => {
    // FIXTURE_1500x2250 is ~20102 bytes / (1500*2250 = 3 375 000 px) ≈ 0.006
    // bpp — well below the 0.05 threshold. GB wins the chain (OL direct + OL
    // cover_id miss via 404 / no cover_id) so the suspect-cover check fires.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/")) {
        return new Response(null, { status: 404 });
      }
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
            { extraLarge: "https://books.google.com/extra.jpg" },
            {},
            { pdf: { isAvailable: true }, viewability: "PARTIAL" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.startsWith("https://books.google.com/")) {
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

    expect(sentryCaptureMessage).toHaveBeenCalledWith(
      "catalog_cover_suspect_low_bpp",
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({ catalog_audit: "suspect_cover" }),
      }),
    );
  });

  it("does NOT capture Sentry warning when cover source is not google_books", async () => {
    // OL direct-ISBN tier wins with FIXTURE_1500x2250. Even though that
    // fixture's bpp is below threshold, the suspect-cover check fires only
    // for `cover.source === "google_books"`.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
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
            { extraLarge: "https://books.google.com/extra.jpg" },
            {},
            { pdf: { isAvailable: true } },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await resolveIsbn(supabase as never, "9780743273565", deps({ fetchFn }));

    expect(sentryCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("resolveTitleAuthor – Sentry suspect-cover warning (Task 10)", () => {
  function coldMissSupabase() {
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null }, // initial select - no row
      { data: null, error: null }, // selectBySha - no dedup
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });
    return supabase;
  }

  beforeEach(() => sentryCaptureMessage.mockClear());

  it("captures Sentry warning when accepted GB cover (title/author path) has low bpp", async () => {
    // FIXTURE_1500x2250 is ~20KB / 3.375M px ≈ 0.006 bpp — below 0.05 threshold.
    // title/author flow has no ISBN, so OL direct + cover_id tiers can't fire;
    // GB wins the chain and the suspect-cover check runs.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
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
            { extraLarge: "https://books.google.com/extra.jpg" },
            {},
            { pdf: { isAvailable: true }, viewability: "PARTIAL" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.startsWith("https://books.google.com/")) {
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

    expect(sentryCaptureMessage).toHaveBeenCalledWith(
      "catalog_cover_suspect_low_bpp",
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({ catalog_audit: "suspect_cover" }),
        extra: expect.objectContaining({
          normalizedTitleAuthor: expect.any(String),
        }),
      }),
    );
  });

  it("does NOT capture Sentry warning when cover source is not google_books (title/author path)", async () => {
    // OL search returns a cover_i so OL cover_id wins.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({ numFound: 1, docs: [{ cover_i: 99999 }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("covers.openlibrary.org/b/id/99999")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            { extraLarge: "https://books.google.com/extra.jpg" },
            {},
            { pdf: { isAvailable: true } },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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

    expect(sentryCaptureMessage).not.toHaveBeenCalled();
  });
});
