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

  it("GB xlarge wins over OL search cover_id at the same floor (reorder 2026-05-31)", async () => {
    // Chain order after work-resolver reorder (2026-05-31):
    //   1. OL direct-ISBN  → 404 (fails, advances)
    //   2. GB xlarge       → pdf.isAvailable=true + extraLarge URL → WINS here
    //   3. OL work-covers  → would be checked next (not reached)
    //   4. OL search cover_id (demoted) → 12345 cover available, but GB wins first
    //   5. iTunes          → not reached
    //
    // Pre-reorder, the OL search cover_id leg ran before GB so the OL cover
    // won. Post-reorder GB xlarge is leg 2 — it wins when pdf.isAvailable=true
    // and the cover clears the same floor, because it runs before the demoted
    // OL search-cover_id leg (leg 4). The #209 pdf.isAvailable filter justifies
    // GB-first: a GB cover backed by real PDF bytes is more canonical than an
    // OL library-scan image.
    const supabase = coldMissSupabase();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL direct ISBN — 404 so it does not short-circuit the test.
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
      // OL data document — empty (no embedded cover URL, no works key).
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(olNoCoverResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL search — returns a cover_i with no valid work key, so the work
      // resolver finds nothing; leg 3 (work-covers) produces no walker.
      // The cover_i itself is available for the demoted leg 4, but by then
      // GB (leg 2) has already won.
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({ numFound: 1, docs: [{ cover_i: 12345 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("openlibrary.org/works/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // OL cover_id endpoint — cover available, but never reached because GB wins first.
      if (url.includes("covers.openlibrary.org/b/id/12345")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB offers a premium cover with a filter-passing pdf.isAvailable=true.
      // This is leg 2 and runs before the OL search-cover_id leg (leg 4),
      // so GB wins even though OL also has a valid cover at the same floor.
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
    expect(p_row.cover_source).toBe("google_books");
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
  it("title/author: OL search resolves work; chain resolves via work-covers when GB has no imageLinks", async () => {
    // resolveTitleAuthor; GB has no imageLinks; iTunes skipped (no isbn).
    // New behavior (work-resolver reorder): the TA path calls buildWorkResolution
    // (limit=10 search → rank → work doc → WorkCoverWalker). The walker walks
    // work.covers[0] = 9876; covers.openlibrary.org/b/id/9876-L returns 600×900.
    // cover_source = "openlibrary_work" (not "openlibrary_search_title" — that was
    // the pre-resolver path that used the cover_i directly from the limit=1 search).
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
      // OL limit=10 search by title/author (used by resolveWork inside buildWorkResolution).
      // Doc must have a valid OL work key + title+author fields that pass acceptableMatch,
      // plus the ranking signals edition_count/first_publish_year used by rankWorkCandidates.
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            numFound: 1,
            docs: [
              {
                key: "/works/OL12345W",
                title: "The Great Gatsby",
                author_name: ["F. Scott Fitzgerald"],
                edition_count: 10,
                first_publish_year: 1925,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OL work doc — returns cover ID 9876 for the walker to walk.
      if (url.includes("openlibrary.org/works/OL12345W.json")) {
        return new Response(JSON.stringify({ covers: [9876] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL cover byte fetches (b/id/9876-L) — serve 600×900 fixture.
      if (url.includes("covers.openlibrary.org")) {
        return new Response(FIXTURE_600x900, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB — no imageLinks → cover chain leg 2 fails; walker (leg 3) carries it.
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
    // Cover resolved via WorkCoverWalker (work-covers leg), not the old
    // search cover_i leg — the walker is what picks up OL covers now.
    expect(p_row.cover_source).toBe("openlibrary_work");
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

// ─── End-to-end resolver tests (work-resolver integration) ──────────────────

describe("resolveTitleAuthor – Martian TA happy path (work-resolver)", () => {
  it("ISBN-less Martian (TA path) → openlibrary_work cover + openlibrary description, no library-stub blurb", async () => {
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null },
      { data: null, error: null }, // selectBySha dedup
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });
    supabase._results.set("book_catalog.update", { data: null, error: null });

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL limit=10 search — returns the canonical Martian work.
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            numFound: 1,
            docs: [
              {
                key: "/works/OL17091839W",
                title: "The Martian",
                author_name: ["Andy Weir"],
                edition_count: 74,
                first_publish_year: 2011,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OL work doc — description + cover ID 11447888.
      if (url.includes("openlibrary.org/works/OL17091839W.json")) {
        return new Response(
          JSON.stringify({
            description:
              "The Martian is a 2011 science fiction novel about an astronaut stranded on Mars.",
            covers: [11447888],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OL cover bytes (walker fetches b/id/11447888-L) — serve 1500×2250 premium fixture.
      if (url.includes("covers.openlibrary.org")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB — library-distribution stub: no imageLinks, stub description.
      // Stub description must be rejected so description comes from OL.
      if (url.includes("googleapis.com/books")) {
        return new Response(
          gbVolumesResponse(
            {},
            {
              description: "For use in schools and libraries only.",
            },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // iTunes: no results (TA path has no ISBN to key on anyway).
      if (url.includes("itunes.apple.com")) {
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

    const result = await resolveTitleAuthor(
      supabase as never,
      "The Martian",
      "Andy Weir",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_title_author",
    );
    expect(upsertCall).toBeDefined();
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;

    // Cover must come from the work-covers walker (leg 3), not GB or OL stub.
    expect(p_row.cover_source).toBe("openlibrary_work");
    expect(result.row.cover_max_width).toBeGreaterThanOrEqual(1200);

    // Description must come from OL (the work doc), not GB library stub.
    expect(p_row.description_provider).toBe("openlibrary");
    expect(typeof p_row.description).toBe("string");
    expect(p_row.description as string).toContain("2011 science fiction novel");
    expect(p_row.description as string).not.toContain(
      "For use in schools and libraries only",
    );
  });
});

describe("resolveIsbn – ISBN sibling-lift via work-covers (#470)", () => {
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
    supabase._results.set("book_catalog.update", { data: null, error: null });
    return supabase;
  }

  it("OL-direct + GB miss the floor but a work edition cover clears it → cover_source openlibrary_work", async () => {
    const supabase = coldMissSupabase();

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL data doc — returns the work key so buildWorkResolution can use it.
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(
          JSON.stringify({
            "ISBN:9780743273565": {
              title: "Test Book",
              works: [{ key: "/works/OL2W" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OL work doc — fetched once by loadOpenLibraryData (leg metadata); the
      // walker reuses that doc via the work-doc lookup (#486), so this handler
      // is hit a single time per resolve. The dedicated single-fetch test
      // below asserts the count.
      if (url.includes("openlibrary.org/works/OL2W.json")) {
        return new Response(JSON.stringify({ covers: [77001] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL direct-ISBN cover (leg 1) — 404 so it does not win.
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
      // Walker cover fetch (leg 3, b/id/77001-L) — serve 1500×2250 fixture.
      if (url.includes("covers.openlibrary.org/b/id/77001")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // GB — no usable cover (no imageLinks).
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // OL search (discoverOpenLibraryCoverId + work ranker limit=10) — no docs,
      // so the demoted search-cover_id leg (leg 4) has nothing to fall back on.
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // iTunes — no results.
      if (url.includes("itunes.apple.com")) {
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
    // Walker (leg 3) resolved the work edition cover; direct-ISBN + GB both failed.
    expect(p_row.cover_source).toBe("openlibrary_work");
  });

  it("cold cover resolve fetches /works/{id}.json exactly once (no double-fetch, #486)", async () => {
    const supabase = coldMissSupabase();
    let workDocFetches = 0;

    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(
          JSON.stringify({
            "ISBN:9780743273565": {
              title: "Test Book",
              works: [{ key: "/works/OL2W" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("openlibrary.org/works/OL2W.json")) {
        workDocFetches++;
        return new Response(JSON.stringify({ covers: [77001] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
      if (url.includes("covers.openlibrary.org/b/id/77001")) {
        return new Response(FIXTURE_1500x2250, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(gbVolumesResponse(), {
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
      if (url.includes("itunes.apple.com")) {
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

    // loadOpenLibraryData fetches the work doc; the walker reuses it via the
    // work-doc lookup rather than re-fetching. Exactly one GET.
    expect(workDocFetches).toBe(1);
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

// ─── #449: ctx title/author overrides upstream stub metadata ────────────────

describe("resolveIsbn – ctx title/author override (#449)", () => {
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
    supabase._results.set("book_catalog.update", { data: null, error: null });
    return supabase;
  }

  /** OL + GB both return pre-publication stub title/author for the ISBN.
   *  GB volume otherwise valid (description fills, pdf.isAvailable=true). */
  function stubMetadataFetch() {
    const GB_URL =
      "https://books.google.com/books/content?id=stubvol&img=1&zoom=0";
    return vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(
          JSON.stringify({
            "ISBN:9781668082461": {
              title: "Untitled MJ",
              authors: [{ name: "To Be Confirmed Gallery" }],
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
            {
              title: "Untitled MJ",
              authors: ["To Be Confirmed Gallery"],
              description: "Real description copy from publisher.",
            },
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

  it("writes ctx.title and ctx.author to book_catalog when supplied", async () => {
    const supabase = coldMissSupabase();
    const d = deps({ fetchFn: stubMetadataFetch() });

    await resolveIsbn(supabase as never, "9781668082461", d, {
      title: "Are You Mad at Me?",
      author: "Meg Josephson",
    });

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.title).toBe("Are You Mad at Me?");
    expect(p_row.author).toBe("Meg Josephson");
  });

  it("falls back to upstream title/author when ctx is absent", async () => {
    // Catalog-warmup cron path: no ctx. Resolver still writes whatever
    // upstream supplies, even when that's a pre-pub stub. The cron-time
    // fallback is documented as an acceptable trade-off in the issue body.
    const supabase = coldMissSupabase();
    const d = deps({ fetchFn: stubMetadataFetch() });

    await resolveIsbn(supabase as never, "9781668082461", d);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.title).toBe("Untitled MJ");
    expect(p_row.author).toBe("To Be Confirmed Gallery");
  });

  it("ctx override does not disturb other resolved fields (description, cover)", async () => {
    const supabase = coldMissSupabase();
    const d = deps({ fetchFn: stubMetadataFetch() });

    await resolveIsbn(supabase as never, "9781668082461", d, {
      title: "Are You Mad at Me?",
      author: "Meg Josephson",
    });

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.description).toBe("Real description copy from publisher.");
    expect(p_row.description_provider).toBe("google_books");
    expect(p_row.cover_source).toBe("google_books");
  });
});

describe("resolveIsbn – OL title/author cover_id fall-through (#450)", () => {
  // AYMaM-style fixture: queried-ISBN edition has no cover on OL; OL
  // ISBN-keyed search returns zero docs (cross-work stub case); the only
  // discovery path is title+author search. Verifies the Phase 1 fix from
  // issue #450: discoverOpenLibraryCoverId falls through to TA search and
  // adopts the cover_id when acceptableMatch passes.

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
    supabase._results.set("book_catalog.update", { data: null, error: null });
    return supabase;
  }

  /** Build a fetchFn that surfaces OL-side state under operator control.
   *  @param taSearch — body returned for the title+author search. Set
   *  numFound:0 to simulate the absent-cover case; supply docs[] with
   *  cover_i to exercise the fall-through.
   *  @param olCoverHandler — handler for /b/id/{id}-L.jpg. */
  function makeFetch(
    taSearch: { numFound: number; docs: unknown[] },
    olCoverHandler: (url: string) => Response | null = () => null,
  ) {
    return vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // OL data document — no cover field.
      if (url.includes("openlibrary.org/api/books")) {
        return new Response(
          JSON.stringify({
            "ISBN:9781668082461": { title: "Untitled MJ" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // ISBN-keyed search returns no docs — the cross-work stub case
      // (Pattern B from #450). TA fall-through is the only discovery
      // path left.
      if (url.includes("openlibrary.org/search.json?q=isbn:")) {
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("openlibrary.org/search.json?title=")) {
        return new Response(JSON.stringify(taSearch), {
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
      // OL direct-ISBN cover — 404 so the chain has to use cover_id.
      if (url.startsWith("https://covers.openlibrary.org/b/isbn/")) {
        return new Response(null, { status: 404 });
      }
      if (url.startsWith("https://covers.openlibrary.org/b/id/")) {
        const handled = olCoverHandler(url);
        if (handled) return handled;
        return new Response(null, { status: 404 });
      }
      // GB — no imageLinks so the cover chain stays on OL.
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
  }

  it("adopts cover_id from TA search when acceptableMatch passes", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = makeFetch(
      {
        numFound: 1,
        docs: [
          {
            cover_i: 15201691,
            title: "Are You Mad at Me?",
            author_name: ["Meg Josephson"],
            key: "/works/OL44545421W",
          },
        ],
      },
      (url) =>
        url.includes("/b/id/15201691")
          ? new Response(FIXTURE_1500x2250, {
              status: 200,
              headers: { "content-type": "image/jpeg" },
            })
          : null,
    );

    await resolveIsbn(supabase as never, "9781668082461", deps({ fetchFn }), {
      title: "Are You Mad at Me?",
      author: "Meg Josephson",
    });

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.openlibrary_cover_id).toBe(15201691);
    expect(p_row.cover_source).toBe("openlibrary_isbn");
  });

  it("rejects TA result when author surname does not overlap (acceptableMatch)", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = makeFetch({
      numFound: 1,
      docs: [
        {
          cover_i: 99999,
          title: "Are You Mad at Me?",
          author_name: ["John Smith"],
          key: "/works/OL99999W",
        },
      ],
    });

    await resolveIsbn(supabase as never, "9781668082461", deps({ fetchFn }), {
      title: "Are You Mad at Me?",
      author: "Meg Josephson",
    });

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.openlibrary_cover_id).toBeNull();
    expect(p_row.cover_source).toBeNull();
  });

  it("rejects TA result when title token does not overlap (acceptableMatch)", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = makeFetch({
      numFound: 1,
      docs: [
        {
          cover_i: 88888,
          title: "Completely Different Memoir",
          author_name: ["Meg Josephson"],
          key: "/works/OL88888W",
        },
      ],
    });

    await resolveIsbn(supabase as never, "9781668082461", deps({ fetchFn }), {
      title: "Are You Mad at Me?",
      author: "Meg Josephson",
    });

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.openlibrary_cover_id).toBeNull();
  });

  it("rejects TA result when doc author's first-name coincides with ctx surname (surname-only gate)", async () => {
    // Pins the surname-only branch: the doc surname is "meg" (last
    // whitespace token of "Some Person Meg"), which happens to be
    // ctx.author's first name. Surname-to-surname comparison correctly
    // rejects because ctxSurnames = {"josephson"}.
    const supabase = coldMissSupabase();
    const fetchFn = makeFetch({
      numFound: 1,
      docs: [
        {
          cover_i: 77777,
          title: "Are You Mad at Me?",
          author_name: ["Some Person Meg"],
          key: "/works/OL77777W",
        },
      ],
    });

    await resolveIsbn(supabase as never, "9781668082461", deps({ fetchFn }), {
      title: "Are You Mad at Me?",
      author: "Meg Josephson",
    });

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.openlibrary_cover_id).toBeNull();
  });

  it("rejects TA result when only a single generic title token overlaps (≥2 floor)", async () => {
    // Pins the min(2, len) title-overlap floor: ctx has 4 significant
    // tokens ("long","story","family","life"); doc shares only "story"
    // — a generic word that would have falsely passed an any-token gate.
    const supabase = coldMissSupabase();
    const fetchFn = makeFetch({
      numFound: 1,
      docs: [
        {
          cover_i: 66666,
          title: "Short Story Collection",
          author_name: ["Meg Josephson"],
          key: "/works/OL66666W",
        },
      ],
    });

    await resolveIsbn(supabase as never, "9781668082461", deps({ fetchFn }), {
      title: "The Long Story of Family Life",
      author: "Meg Josephson",
    });

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.openlibrary_cover_id).toBeNull();
  });

  it("does not fire TA search when ctx is absent", async () => {
    const supabase = coldMissSupabase();
    const fetchFn = makeFetch({
      // Even if this would match, no ctx means we should never call it.
      numFound: 1,
      docs: [
        {
          cover_i: 15201691,
          title: "Are You Mad at Me?",
          author_name: ["Meg Josephson"],
        },
      ],
    });

    await resolveIsbn(supabase as never, "9781668082461", deps({ fetchFn }));

    const taSearchCalls = (
      fetchFn as ReturnType<typeof vi.fn>
    ).mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes("openlibrary.org/search.json?title="),
    );
    expect(taSearchCalls).toHaveLength(0);

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.openlibrary_cover_id).toBeNull();
  });
});

describe("resolveTitleAuthor – caller args override stub metadata (#449)", () => {
  function coldMissTaSupabase() {
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [], error: null },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });
    supabase._results.set("book_catalog.update", { data: null, error: null });
    return supabase;
  }

  it("writes function-arg title/author over OL search-normalized stub", async () => {
    // OL search returns a stub title / author for the queried (title,author);
    // the caller-supplied values are authoritative and must win.
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            numFound: 1,
            docs: [
              {
                title: "Untitled MJ",
                author_name: ["To Be Confirmed Gallery"],
                cover_i: 99999,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("googleapis.com/books")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(512), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const supabase = coldMissTaSupabase();
    await resolveTitleAuthor(
      supabase as never,
      "Are You Mad at Me?",
      "Meg Josephson",
      deps({ fetchFn }),
    );

    const upsertCall = supabase._rpcCalls.find(
      (c) => c.name === "upsert_book_catalog_by_title_author",
    );
    const p_row = (upsertCall!.args as { p_row: Record<string, unknown> })
      .p_row;
    expect(p_row.title).toBe("Are You Mad at Me?");
    expect(p_row.author).toBe("Meg Josephson");
  });
});

describe("resolveTitleAuthor – find by stored lookup key (#489 Fix A)", () => {
  // A drifted row whose stored key does NOT derive from its own title/author
  // (the #449 ctx-override froze the key at creation). Stale fail_reasons so
  // shouldAttempt is true and the resolver proceeds past the cache gate.
  function driftedRow(): Record<string, unknown> {
    const stale = "2026-01-22T00:00:00Z"; // > 90-day TTL before fixture "now"
    return {
      isbn: null,
      normalized_title_author: "1984|george orwell", // frozen at creation
      title: "1984 (adaptation)", // drifted via #449 override
      author: "Michael Dean, George Orwell",
      storage_path: null,
      pending_storage: false,
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
    };
  }

  function emptyUpstreamFetch(): typeof fetch {
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
          JSON.stringify({ kind: "books#volumes", totalItems: 0, items: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("SELECTs the existing row by the stored lookup key, not the re-derived key", async () => {
    const supabase = createMockSupabase();
    // 1st select → initial lookup HITS the drifted row; 2nd → selectBySha miss.
    supabase._resultsQueue.set("book_catalog.select", [
      { data: [driftedRow()], error: null },
      { data: null, error: null },
    ]);
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });
    supabase._results.set("book_catalog.update", { data: null, error: null });

    await resolveTitleAuthor(
      supabase as never,
      "1984 (adaptation)",
      "Michael Dean, George Orwell",
      deps({ fetchFn: emptyUpstreamFetch(), mutex: noopMutex }),
      undefined, // _fields
      "1984|george orwell", // lookupKey — the row's STORED key
    );

    // The initial book_catalog lookup must filter normalized_title_author by
    // the STORED lookup key, never by the re-derived drifted key.
    const eqCalls = supabase._chainCalls.filter(
      (c) =>
        c.operation === "select" &&
        c.method === "eq" &&
        c.args[0] === "normalized_title_author",
    );
    const filteredKeys = eqCalls.map((c) => c.args[1]);
    expect(filteredKeys).toContain("1984|george orwell");
    expect(filteredKeys).not.toContain(
      "1984 adaptation|michael dean george orwell",
    );
  });
});
