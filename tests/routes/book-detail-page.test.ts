import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock-upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: {
    COVER_STORAGE_BACKEND: "supabase",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  },
}));
vi.mock("$env/dynamic/public", () => ({
  env: { PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc" },
}));

const supabase = createMockSupabase();
const adminSupabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => adminSupabase,
}));

const runInBackgroundSpy = vi.fn();
vi.mock("$lib/server/wait-until", () => ({
  runInBackground: runInBackgroundSpy,
}));

const userLimitMock = vi.fn();
vi.mock("$lib/server/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/ratelimit")>();
  return {
    ...actual,
    catalogUserLimiter: {
      ...actual.catalogUserLimiter,
      limit: (...args: unknown[]) => userLimitMock(...args),
    },
  };
});

const { load } =
  await import("../../src/routes/app/book/[bookHash]/+page.server");

// PageServerLoad's inferred return type is `T | void`. SvelteKit erases
// the union at runtime when the load resolves to a value, but the static
// type still includes `void`. Narrow at the call site for assertions.
type LoadResult = Exclude<Awaited<ReturnType<typeof load>>, void>;
async function loadResult(
  event: Parameters<typeof load>[0],
): Promise<LoadResult> {
  const r = await load(event);
  if (!r) throw new Error("load returned void");
  return r as LoadResult;
}

const ISBN = "9780743273565";
const BOOK_HASH = "abc123";
const USER_ID = "u-1";

const bookRow = {
  id: "book-1",
  book_hash: BOOK_HASH,
  title: "Gatsby",
  author: "Fitzgerald",
  isbn: ISBN,
};

beforeEach(() => {
  supabase._results.clear();
  adminSupabase._results.clear();
  runInBackgroundSpy.mockClear();
  userLimitMock.mockReset();
  userLimitMock.mockResolvedValue({
    success: true,
    reset: Date.now() + 60_000,
    limit: 10,
    remaining: 9,
    pending: Promise.resolve(),
  });
  // Feed RPC always succeeds with empty array — page renders with empty rows.
  supabase._results.set("rpc.get_highlight_feed", { data: [], error: null });
});

function buildEvent() {
  const url = new URL(`https://example.com/app/book/${BOOK_HASH}`);
  return {
    params: { bookHash: BOOK_HASH },
    cookies: { get: (_: string) => undefined },
    locals: {
      supabase,
      safeGetSession: async () => ({ user: { id: USER_ID } }),
    },
    platform: { context: { waitUntil: vi.fn() } },
    url,
    // Required by @sentry/sveltekit's wrapServerLoadWithSentry, which reads
    // event.request.method to populate the http.method span attribute.
    request: new Request(url),
  } as unknown as Parameters<typeof load>[0];
}

describe("load /app/book/[bookHash] — per-user catalog limiter", () => {
  it("renders placeholder + skips runInBackground when per-user limiter denies", async () => {
    supabase._results.set("books.select", { data: [bookRow], error: null });
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
      limit: 10,
      remaining: 0,
      pending: Promise.resolve(),
    });

    const result = await loadResult(buildEvent());

    expect(result.catalog.cover_url).toBe("/cover-placeholder.svg");
    expect(result.book).toMatchObject({ book_hash: BOOK_HASH });
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("schedules runInBackground when limiter allows on cold miss", async () => {
    supabase._results.set("books.select", { data: [bookRow], error: null });
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
      limit: 10,
      remaining: 9,
      pending: Promise.resolve(),
    });

    await load(buildEvent());

    expect(userLimitMock).toHaveBeenCalledTimes(1);
    expect(userLimitMock).toHaveBeenCalledWith(USER_ID);
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
  });

  it("skips limiter check entirely on hit path (warm catalog row)", async () => {
    supabase._results.set("books.select", { data: [bookRow], error: null });
    supabase._results.set("book_catalog.select", {
      data: [
        {
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
          description: "...",
          description_provider: "openlibrary",
          publisher: null,
          page_count: null,
          subjects: null,
          published_date: null,
        },
      ],
      error: null,
    });
    // Even configured to deny, must not be called on hit path.
    userLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 30_000,
      limit: 10,
      remaining: 0,
      pending: Promise.resolve(),
    });

    const result = await loadResult(buildEvent());

    expect(userLimitMock).not.toHaveBeenCalled();
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    expect(result.catalog.cover_url).toContain("ab/cd.jpg");
  });

  it("renders placeholder + skips runInBackground on Upstash failClosed", async () => {
    supabase._results.set("books.select", { data: [bookRow], error: null });
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await loadResult(buildEvent());

    expect(result.catalog.cover_url).toBe("/cover-placeholder.svg");
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });
});

describe("load /app/book/[bookHash] — title/author fallback (no ISBN)", () => {
  const SIDELOADED_BOOK = {
    id: "book-2",
    book_hash: BOOK_HASH,
    title: "Sideloaded Book",
    author: "Some Author",
    isbn: null,
  };

  it("hits the title/author cache and renders the resolved cover", async () => {
    supabase._results.set("books.select", {
      data: [SIDELOADED_BOOK],
      error: null,
    });
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: null,
          title: SIDELOADED_BOOK.title,
          author: SIDELOADED_BOOK.author,
          description: "blurb",
          description_provider: "openlibrary",
          publisher: null,
          page_count: null,
          subjects: null,
          published_date: null,
          language: null,
          series_name: null,
          series_position: null,
          storage_path: "tt/aa.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });
    userLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 30_000,
      limit: 10,
      remaining: 0,
      pending: Promise.resolve(),
    });

    const result = await loadResult(buildEvent());

    expect(result.catalog.cover_url).toContain("tt/aa.jpg");
    expect(result.catalog.description).toBe("blurb");
    // Hit path must not consult the user limiter nor schedule work.
    expect(userLimitMock).not.toHaveBeenCalled();
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("schedules background resolveTitleAuthor on cold miss when limiter allows", async () => {
    supabase._results.set("books.select", {
      data: [SIDELOADED_BOOK],
      error: null,
    });
    supabase._results.set("book_catalog.select", { data: [], error: null });

    await load(buildEvent());

    expect(userLimitMock).toHaveBeenCalledTimes(1);
    expect(userLimitMock).toHaveBeenCalledWith(USER_ID);
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
  });

  it("renders placeholder + skips runInBackground when limiter denies", async () => {
    supabase._results.set("books.select", {
      data: [SIDELOADED_BOOK],
      error: null,
    });
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
      limit: 10,
      remaining: 0,
      pending: Promise.resolve(),
    });

    const result = await loadResult(buildEvent());

    expect(result.catalog.cover_url).toBe("/cover-placeholder.svg");
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("renders placeholder without scheduling when title or author is missing", async () => {
    supabase._results.set("books.select", {
      data: [{ ...SIDELOADED_BOOK, author: null }],
      error: null,
    });
    supabase._results.set("book_catalog.select", { data: [], error: null });

    const result = await loadResult(buildEvent());

    expect(result.catalog.cover_url).toBe("/cover-placeholder.svg");
    // Nothing to resolve — limiter not consulted, no background work.
    expect(userLimitMock).not.toHaveBeenCalled();
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });
});

describe("load /app/book/[bookHash] — feed-card cover enrichment (issue #111)", () => {
  it("populates coverUrl on each highlight card via enrichFeedRowsWithCovers", async () => {
    // Book-detail page must render per-card thumbnails matching the home
    // feed / pagination handler. Prior to issue #111 the loader hard-coded
    // coverUrl: null, diverging from the pagination handler (which calls
    // enrichFeedRowsWithCovers). Cards 1-50 (loader) showed placeholder
    // while cards 51+ (pagination) showed thumbnails — and a sort change
    // re-fetched everything through pagination, flipping all cards. Fix:
    // loader calls enrichFeedRowsWithCovers too so all cards stay enriched.
    supabase._results.set("books.select", { data: [bookRow], error: null });
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN,
          title: "Gatsby",
          author: "Fitzgerald",
          description: "...",
          description_provider: "openlibrary",
          publisher: null,
          page_count: null,
          subjects: null,
          published_date: null,
          language: null,
          series_name: null,
          series_position: null,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
      ],
      error: null,
    });
    supabase._results.set("rpc.get_highlight_feed", {
      data: [
        {
          highlight_id: "h-1",
          book_hash: BOOK_HASH,
          book_title: "Gatsby",
          book_author: "Fitzgerald",
          book_isbn: ISBN,
          book_highlight_count: 1,
          chapter_index: 0,
          chapter_title: null,
          start_word: 0,
          end_word: 1,
          text: "t",
          styles: null,
          paragraph_breaks: null,
          note_text: null,
          note_updated_at: null,
          updated_at: "2026-01-01T00:00:00Z",
          next_cursor: null,
        },
      ],
      error: null,
    });

    const result = await loadResult(buildEvent());

    expect(result.items).toHaveLength(1);
    expect(result.items[0].coverUrl).toContain("ab/cd.jpg");
  });
});
