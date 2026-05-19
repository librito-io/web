import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../../helpers";
import type { FeedRow } from "$lib/feed/types";

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

const runInBackgroundSpy = vi.fn();
vi.mock("$lib/server/wait-until", () => ({
  runInBackground: runInBackgroundSpy,
}));

const adminSupabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => adminSupabase,
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

const resolveIsbnSpy = vi.fn(
  async (
    _supabase: unknown,
    _isbn: string,
    _deps: { mutex?: unknown },
  ): Promise<{ cached: boolean; rateLimited: boolean; row: unknown }> => ({
    cached: false,
    rateLimited: false,
    row: {},
  }),
);
const resolveTitleAuthorSpy = vi.fn(
  async (
    _supabase: unknown,
    _title: string,
    _author: string,
    _deps: { mutex?: unknown },
  ): Promise<{ cached: boolean; rateLimited: boolean; row: unknown }> => ({
    cached: false,
    rateLimited: false,
    row: {},
  }),
);
vi.mock("$lib/server/catalog/fetcher", () => ({
  resolveIsbn: resolveIsbnSpy,
  resolveTitleAuthor: resolveTitleAuthorSpy,
}));

const mutexSentinel = { __mutex: true };
vi.mock("$lib/server/catalog/mutex", () => ({
  getCatalogMutex: vi.fn(async () => mutexSentinel),
}));

const { enrichFeedRowsWithCovers } =
  await import("$lib/server/catalog/feed-enrichment");

const USER_ID = "u-1";
const ISBN_A = "9780743273565"; // Gatsby
const ISBN_B = "9780451524935"; // 1984

function row(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    highlight_id: "h-" + Math.random().toString(36).slice(2),
    book_hash: "bh-1",
    book_title: "T",
    book_author: "A",
    book_isbn: null,
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
    ...overrides,
  };
}

beforeEach(() => {
  runInBackgroundSpy.mockClear();
  resolveIsbnSpy.mockClear();
  resolveTitleAuthorSpy.mockClear();
  userLimitMock.mockReset();
  userLimitMock.mockResolvedValue({
    success: true,
    reset: Date.now() + 60_000,
    limit: 10,
    remaining: 9,
  });
  adminSupabase._results.clear();
});

describe("enrichFeedRowsWithCovers", () => {
  it("returns empty list when given no rows; does not query or schedule", async () => {
    const supabase = createMockSupabase();
    const items = await enrichFeedRowsWithCovers(supabase, USER_ID, []);
    expect(items).toEqual([]);
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    expect(userLimitMock).not.toHaveBeenCalled();
  });

  it("returns coverUrl=null and skips enrichment for rows with neither ISBN nor title+author", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });

    const rows = [
      row({ book_isbn: null, book_title: null, book_author: null }),
      row({ book_isbn: null, book_title: "only title", book_author: null }),
    ];
    const items = await enrichFeedRowsWithCovers(supabase, USER_ID, rows);

    expect(items.map((i) => i.coverUrl)).toEqual([null, null]);
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    expect(userLimitMock).not.toHaveBeenCalled();
  });

  it("fills coverUrl from book_catalog for cached ISBNs; does not schedule background work", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "covers/abc",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: ISBN_A }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].coverUrl).toBeTruthy();
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("schedules resolveIsbn for cold-miss ISBNs when per-user limiter allows", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });

    const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: ISBN_A }),
      row({ book_isbn: ISBN_B }),
    ]);

    expect(items.map((i) => i.coverUrl)).toEqual([null, null]);
    expect(userLimitMock).toHaveBeenCalledWith(USER_ID);
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(2);
    // Each background work, when invoked, calls resolveIsbn with the mutex
    // we mocked. Drain by invoking each scheduled callback.
    for (const call of runInBackgroundSpy.mock.calls) {
      const work = call[0] as () => Promise<unknown>;
      await work();
    }
    expect(resolveIsbnSpy).toHaveBeenCalledTimes(2);
    const calledIsbns = resolveIsbnSpy.mock.calls.map((c) => c[1]);
    expect(new Set(calledIsbns)).toEqual(new Set([ISBN_A, ISBN_B]));
    const deps = resolveIsbnSpy.mock.calls[0][2] as { mutex: unknown };
    expect(deps.mutex).toBe(mutexSentinel);
  });

  it("does NOT schedule when per-user limiter denies (failClosed posture)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 60_000,
      limit: 10,
      remaining: 0,
    });

    await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: ISBN_A }),
    ]);

    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("skips scheduling when the limiter upstream errors (fail-closed denies)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockRejectedValue(new Error("upstash boom"));

    await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: ISBN_A }),
    ]);

    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("does NOT cascade into N resolveIsbn schedules when book_catalog lookup throws (issue #110)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: null,
      error: { message: "boom" },
    });

    const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: ISBN_A }),
      row({ book_isbn: ISBN_B }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0].coverUrl).toBeNull();
    expect(items[1].coverUrl).toBeNull();
    // DB-blip on the ISBN lookup must not trigger cold-miss fan-out for
    // every ISBN on the page. Treat as "unknown state, do nothing this
    // request" — warmup cron backfills on next pass.
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    expect(userLimitMock).not.toHaveBeenCalled();
  });

  it("does NOT schedule resolveIsbn for negative-cached ISBNs (issue #110)", async () => {
    const supabase = createMockSupabase();
    // Catalog row exists with storage_path null — negative-cache. The view
    // helper returns this ISBN in negativeIsbns; enrichment must skip the
    // cold-miss schedule (warmup cron is the retry path).
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: null,
          cover_storage_backend: null,
          cover_max_width: null,
        },
      ],
      error: null,
    });

    const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: ISBN_A }),
    ]);

    expect(items[0].coverUrl).toBeNull();
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    // Single ISBN, fully negative-cached → no work to schedule, so no
    // limiter call either.
    expect(userLimitMock).not.toHaveBeenCalled();
  });

  it("caps fan-out at per-user budget — denies after N successes short-circuit remainder (issue #110)", async () => {
    // Bulk-fan-out shape: 50 cold-miss ISBNs from one user. Per-user
    // limiter is 10/min — expect at most 10 scheduled resolves, with the
    // 11th limiter call denying and the loop bailing.
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });

    // First 10 calls succeed, 11th denies (sliding-window over budget).
    userLimitMock.mockReset();
    for (let i = 0; i < 10; i++) {
      userLimitMock.mockResolvedValueOnce({
        success: true,
        reset: Date.now() + 60_000,
        limit: 10,
        remaining: 9 - i,
      });
    }
    userLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 60_000,
      limit: 10,
      remaining: 0,
    });

    const rows: FeedRow[] = [];
    for (let i = 0; i < 50; i++) {
      // Generate 50 distinct canonical ISBN-13s. EAN body 978 + 9 unique
      // digits + checksum placeholder (any digit is fine for canon since
      // canonicalizeIsbn validates but tests fabricated values here).
      const body = `97804${String(i).padStart(7, "0")}`;
      // Compute ISBN-13 checksum so canonicalizeIsbn accepts.
      let sum = 0;
      for (let d = 0; d < 12; d++) {
        const digit = Number(body[d]);
        sum += d % 2 === 0 ? digit : digit * 3;
      }
      const check = (10 - (sum % 10)) % 10;
      rows.push(row({ book_isbn: body + String(check) }));
    }

    await enrichFeedRowsWithCovers(supabase, USER_ID, rows);

    expect(runInBackgroundSpy).toHaveBeenCalledTimes(10);
    expect(userLimitMock).toHaveBeenCalledTimes(11);
  });

  it("dedupes ISBNs across rows before calling the cover lookup or scheduling resolves", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });

    await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: ISBN_A }),
      row({ book_isbn: ISBN_A }),
      row({ book_isbn: ISBN_A }),
    ]);

    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
  });

  it("skips ISBNs that fail canonicalisation", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });

    const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
      row({ book_isbn: "not-a-real-isbn" }),
    ]);

    expect(items[0].coverUrl).toBeNull();
    // canonByRaw is empty → uniqueCanon empty → no limiter check, no schedule
    expect(userLimitMock).not.toHaveBeenCalled();
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  describe("title/author fallback for ISBN-null rows", () => {
    it("fills coverUrl from book_catalog for cached (title, author) match", async () => {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", {
        data: [
          {
            normalized_title_author: "some book|some author",
            storage_path: "ab/cd.jpg",
            cover_storage_backend: "supabase",
          },
        ],
        error: null,
      });

      const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
        row({
          book_isbn: null,
          book_title: "Some Book",
          book_author: "Some Author",
        }),
      ]);

      expect(items).toHaveLength(1);
      expect(items[0].coverUrl).toContain("ab/cd.jpg");
      expect(runInBackgroundSpy).not.toHaveBeenCalled();
    });

    it("schedules resolveTitleAuthor for cold-miss (title, author) when limiter allows", async () => {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", { data: [], error: null });

      await enrichFeedRowsWithCovers(supabase, USER_ID, [
        row({
          book_isbn: null,
          book_title: "Sideloaded Book",
          book_author: "Some Author",
        }),
      ]);

      expect(userLimitMock).toHaveBeenCalledWith(USER_ID);
      expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
      const work = runInBackgroundSpy.mock
        .calls[0][0] as () => Promise<unknown>;
      await work();
      expect(resolveIsbnSpy).not.toHaveBeenCalled();
      expect(resolveTitleAuthorSpy).toHaveBeenCalledTimes(1);
      expect(resolveTitleAuthorSpy.mock.calls[0][1]).toBe("Sideloaded Book");
      expect(resolveTitleAuthorSpy.mock.calls[0][2]).toBe("Some Author");
      const deps = resolveTitleAuthorSpy.mock.calls[0][3] as { mutex: unknown };
      expect(deps.mutex).toBe(mutexSentinel);
    });

    it("dedupes duplicate (title, author) pairs across rows to one scheduled resolve", async () => {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", { data: [], error: null });

      await enrichFeedRowsWithCovers(supabase, USER_ID, [
        row({ book_isbn: null, book_title: "Dup", book_author: "Auth" }),
        row({ book_isbn: null, book_title: "Dup", book_author: "Auth" }),
        // Different casing/punctuation but normalises to the same key
        row({ book_isbn: null, book_title: "DUP!", book_author: "auth" }),
      ]);

      expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
    });

    it("skips scheduling when (title, author) normalises to null", async () => {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", { data: [], error: null });

      await enrichFeedRowsWithCovers(supabase, USER_ID, [
        row({ book_isbn: null, book_title: "!!!", book_author: "???" }),
      ]);

      expect(runInBackgroundSpy).not.toHaveBeenCalled();
      expect(userLimitMock).not.toHaveBeenCalled();
    });

    it("consumes one limiter token per scheduled resolve across mixed ISBN + (title, author) cohort (issue #110)", async () => {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", { data: [], error: null });

      await enrichFeedRowsWithCovers(supabase, USER_ID, [
        row({ book_isbn: ISBN_A }),
        row({
          book_isbn: null,
          book_title: "Sideloaded",
          book_author: "Author",
        }),
      ]);

      // Per-resolve token consumption: one limiter check per scheduled
      // resolve so the user budget tracks actual fan-out, not requests.
      expect(userLimitMock).toHaveBeenCalledTimes(2);
      // Two scheduled background jobs — one resolveIsbn + one resolveTitleAuthor.
      expect(runInBackgroundSpy).toHaveBeenCalledTimes(2);
      for (const call of runInBackgroundSpy.mock.calls) {
        const work = call[0] as () => Promise<unknown>;
        await work();
      }
      expect(resolveIsbnSpy).toHaveBeenCalledTimes(1);
      expect(resolveTitleAuthorSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT cascade into resolveTitleAuthor schedules when title/author lookup throws (issue #110)", async () => {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", {
        data: null,
        error: { message: "boom" },
      });

      const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
        row({
          book_isbn: null,
          book_title: "Some Book",
          book_author: "Some Author",
        }),
        row({
          book_isbn: null,
          book_title: "Another Book",
          book_author: "Another Author",
        }),
      ]);

      expect(items).toHaveLength(2);
      expect(items[0].coverUrl).toBeNull();
      expect(items[1].coverUrl).toBeNull();
      // DB-blip on the TA lookup must not trigger cold-miss fan-out for
      // every (title, author) pair on the page.
      expect(runInBackgroundSpy).not.toHaveBeenCalled();
      expect(userLimitMock).not.toHaveBeenCalled();
    });

    it("does NOT schedule resolveTitleAuthor for negative-cached (title, author) pairs (issue #110)", async () => {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", {
        data: [
          {
            normalized_title_author: "some book|some author",
            storage_path: null,
            cover_storage_backend: null,
            cover_max_width: null,
          },
        ],
        error: null,
      });

      const items = await enrichFeedRowsWithCovers(supabase, USER_ID, [
        row({
          book_isbn: null,
          book_title: "Some Book",
          book_author: "Some Author",
        }),
      ]);

      expect(items[0].coverUrl).toBeNull();
      expect(runInBackgroundSpy).not.toHaveBeenCalled();
      expect(userLimitMock).not.toHaveBeenCalled();
    });
  });
});
