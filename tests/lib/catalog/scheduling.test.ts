import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../../helpers";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock-upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
const dynPrivate: Record<string, string | undefined> = {
  COVER_STORAGE_BACKEND: "supabase",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_IMAGES_API_TOKEN: "tok",
};
vi.mock("$env/dynamic/private", () => ({ env: dynPrivate }));
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
    _deps: unknown,
    _ctx?: { title?: string; author?: string },
    _fields?: string[],
  ) => ({ cached: false, rateLimited: false, row: {} }),
);
const resolveTitleAuthorSpy = vi.fn(
  async (
    _supabase: unknown,
    _title: string,
    _author: string,
    _deps: unknown,
    _fields?: string[],
  ) => ({ cached: false, rateLimited: false, row: {} }),
);
vi.mock("$lib/server/catalog/fetcher", () => ({
  resolveIsbn: resolveIsbnSpy,
  resolveTitleAuthor: resolveTitleAuthorSpy,
}));

const mutexSentinel = { __mutex: true };
vi.mock("$lib/server/catalog/mutex", () => ({
  getCatalogMutex: vi.fn(async () => mutexSentinel),
}));

const { scheduleCatalogResolveIfAllowed } =
  await import("$lib/server/catalog/scheduling");

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
  delete dynPrivate.QSTASH_TOKEN;
  delete dynPrivate.QSTASH_CONSUMER_URL;
});

describe("scheduleCatalogResolveIfAllowed", () => {
  it("default behavior: per-item safeLimit, break on deny", async () => {
    // First call allows, second denies.
    userLimitMock
      .mockResolvedValueOnce({
        success: true,
        reset: Date.now() + 60_000,
        limit: 10,
        remaining: 9,
      })
      .mockResolvedValueOnce({
        success: false,
        reset: Date.now() + 60_000,
        limit: 10,
        remaining: 0,
      });

    await scheduleCatalogResolveIfAllowed("user-1", [
      { kind: "isbn", isbn: "9780000000000" },
      { kind: "isbn", isbn: "9780000000001" },
      { kind: "isbn", isbn: "9780000000002" },
    ]);

    // safeLimit called twice — first allows (schedules), second denies (breaks loop).
    expect(userLimitMock).toHaveBeenCalledTimes(2);
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
  });

  it("bypassUserLimit=true skips safeLimit and schedules every item", async () => {
    const work = Array.from({ length: 20 }, (_, i) => ({
      kind: "isbn" as const,
      isbn: `978000000${i.toString().padStart(4, "0")}`,
    }));

    await scheduleCatalogResolveIfAllowed("synthetic-user", work, {
      bypassUserLimit: true,
    });

    expect(userLimitMock).not.toHaveBeenCalled();
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(20);
  });

  it("bypassUserLimit=true threads fields + ctx into resolveIsbn", async () => {
    await scheduleCatalogResolveIfAllowed(
      "synthetic-user",
      [
        {
          kind: "isbn",
          isbn: "9780000000010",
          ctx: { title: "T1", author: "A1" },
          fields: ["description", "cover"],
        },
      ],
      { bypassUserLimit: true },
    );

    // The runInBackground spy captures a closure; invoke it to observe the
    // resolveIsbn call with the fields argument.
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
    const fn = runInBackgroundSpy.mock.calls[0][0] as () => Promise<unknown>;
    await fn();
    expect(resolveIsbnSpy).toHaveBeenCalledTimes(1);
    const args = resolveIsbnSpy.mock.calls[0];
    expect(args[1]).toBe("9780000000010");
    expect(args[3]).toEqual({ title: "T1", author: "A1" });
    expect(args[4]).toEqual(["description", "cover"]);
  });

  it("bypassUserLimit=true threads fields into resolveTitleAuthor for TA work items", async () => {
    await scheduleCatalogResolveIfAllowed(
      "synthetic-user",
      [
        {
          kind: "ta",
          title: "Ruth",
          author: "Kate Riley",
          fields: ["publisher"],
        },
      ],
      { bypassUserLimit: true },
    );

    const fn = runInBackgroundSpy.mock.calls[0][0] as () => Promise<unknown>;
    await fn();
    expect(resolveTitleAuthorSpy).toHaveBeenCalledTimes(1);
    const args = resolveTitleAuthorSpy.mock.calls[0];
    expect(args[1]).toBe("Ruth");
    expect(args[2]).toBe("Kate Riley");
    expect(args[4]).toEqual(["publisher"]);
  });

  it("empty work list is a no-op", async () => {
    await scheduleCatalogResolveIfAllowed("user-1", [], {
      bypassUserLimit: true,
    });
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    expect(userLimitMock).not.toHaveBeenCalled();
  });
});
