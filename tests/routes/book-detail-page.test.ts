import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  COVER_STORAGE_BACKEND: "supabase",
  UPSTASH_REDIS_REST_URL: "https://mock-upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_IMAGES_API_TOKEN: "tok" },
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
  return {
    params: { bookHash: BOOK_HASH },
    cookies: { get: (_: string) => undefined },
    locals: {
      supabase,
      safeGetSession: async () => ({ user: { id: USER_ID } }),
    },
    platform: { context: { waitUntil: vi.fn() } },
    url: new URL(`https://example.com/app/book/${BOOK_HASH}`),
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await loadResult(buildEvent());

    expect(result.catalog.cover_url).toBe("/cover-placeholder.svg");
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
