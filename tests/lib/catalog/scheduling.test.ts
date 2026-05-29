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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const batchJSONSpy = vi.fn(
  async (_entries: unknown): Promise<any> => undefined,
);
class FakeQstashClient {
  constructor(public opts: unknown) {}
  batchJSON(entries: unknown) {
    return batchJSONSpy(entries);
  }
}
vi.mock("@upstash/qstash", () => ({
  Client: FakeQstashClient,
  Receiver: class {},
}));

const sentryCaptureSpy = vi.fn();
// Defensive stubs across the Sentry surface scheduling.ts MIGHT reach
// today only captureException, but stubs prevent future Sentry.* calls
// from crashing with `undefined is not a function`.
vi.mock("@sentry/sveltekit", () => ({
  captureException: sentryCaptureSpy,
  captureMessage: vi.fn(),
  startInactiveSpan: vi.fn(() => ({
    setStatus: vi.fn(),
    end: vi.fn(),
  })),
  flush: vi.fn(async () => true),
  withMonitor: vi.fn(async <T>(_name: string, fn: () => Promise<T>) => fn()),
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
  delete dynPrivate.QSTASH_URL;
  batchJSONSpy.mockClear();
  batchJSONSpy.mockResolvedValue(undefined);
  sentryCaptureSpy.mockClear();
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

  describe("qstash branch (env set)", () => {
    beforeEach(() => {
      dynPrivate.QSTASH_TOKEN = "qst-tok";
      dynPrivate.QSTASH_CONSUMER_URL =
        "https://qstash-consumer.test/api/queue/catalog-resolve";
      // All three env vars gate the qstash branch (scheduling.ts:106-110).
      // QSTASH_URL pins the region endpoint — added to the prod gate in #460
      // but not threaded here until #474; without it the producer falls back
      // to the inline runInBackground path and every assertion below misses.
      dynPrivate.QSTASH_URL = "https://qstash-eu-central-1.upstash.io";
    });

    // Per-clause absent guards (issue #477). The describe `beforeEach` sets
    // all three env vars, so the happy-path assertions below stay green even
    // if a single clause is deleted from the gate (scheduling.ts:106-110).
    // Each guard unsets ONE leg, leaves the other two, and asserts the inline
    // fallback (runInBackground fan-out, no publish) — so dropping that clause
    // from the OR makes the corresponding test fail. Mirrors the QSTASH_URL
    // absent guard added to catalog-dlq-drain.test.ts in #476.
    it("QSTASH_TOKEN absent → inline fallback, no publish", async () => {
      delete dynPrivate.QSTASH_TOKEN;
      await scheduleCatalogResolveIfAllowed("u", [
        { kind: "isbn", isbn: "9780000000000" },
      ]);
      expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
      expect(batchJSONSpy).not.toHaveBeenCalled();
    });

    it("QSTASH_CONSUMER_URL absent → inline fallback, no publish", async () => {
      delete dynPrivate.QSTASH_CONSUMER_URL;
      await scheduleCatalogResolveIfAllowed("u", [
        { kind: "isbn", isbn: "9780000000000" },
      ]);
      expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
      expect(batchJSONSpy).not.toHaveBeenCalled();
    });

    it("QSTASH_URL absent → inline fallback, no publish", async () => {
      delete dynPrivate.QSTASH_URL;
      await scheduleCatalogResolveIfAllowed("u", [
        { kind: "isbn", isbn: "9780000000000" },
      ]);
      expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
      expect(batchJSONSpy).not.toHaveBeenCalled();
    });

    it("single batchJSON publish, one entry per permitted item", async () => {
      await scheduleCatalogResolveIfAllowed("user-1", [
        { kind: "isbn", isbn: "9780000000000" },
        { kind: "isbn", isbn: "9780000000001" },
      ]);
      expect(runInBackgroundSpy).not.toHaveBeenCalled();
      expect(batchJSONSpy).toHaveBeenCalledTimes(1);
      const entries = batchJSONSpy.mock.calls[0]![0] as Array<
        Record<string, unknown>
      >;
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        queue: "catalog-resolve",
        url: "https://qstash-consumer.test/api/queue/catalog-resolve",
        body: {
          userId: "user-1",
          item: { kind: "isbn", isbn: "9780000000000" },
        },
        retries: 2,
        flowControl: { key: "catalog-resolve", parallelism: 2 },
      });
    });

    it("threads ctx + fields into ISBN message body", async () => {
      await scheduleCatalogResolveIfAllowed(
        "u",
        [
          {
            kind: "isbn",
            isbn: "9780000000000",
            ctx: { title: "T", author: "A" },
            fields: ["cover"],
          },
        ],
        { bypassUserLimit: true },
      );
      const entries = batchJSONSpy.mock.calls[0]![0] as Array<
        Record<string, unknown>
      >;
      expect((entries[0] as any).body.item).toEqual({
        kind: "isbn",
        isbn: "9780000000000",
        ctx: { title: "T", author: "A" },
        fields: ["cover"],
      });
    });

    it("threads title/author + fields into TA message body", async () => {
      await scheduleCatalogResolveIfAllowed(
        "u",
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
      const entries = batchJSONSpy.mock.calls[0]![0] as Array<
        Record<string, unknown>
      >;
      expect((entries[0] as any).body.item).toEqual({
        kind: "ta",
        title: "Ruth",
        author: "Kate Riley",
        fields: ["publisher"],
      });
    });

    it("per-user limiter still gates and breaks on first deny", async () => {
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
      await scheduleCatalogResolveIfAllowed("u", [
        { kind: "isbn", isbn: "9780000000000" },
        { kind: "isbn", isbn: "9780000000001" },
        { kind: "isbn", isbn: "9780000000002" },
      ]);
      expect(userLimitMock).toHaveBeenCalledTimes(2);
      expect(batchJSONSpy).toHaveBeenCalledTimes(1);
      const entries = batchJSONSpy.mock.calls[0]![0] as unknown[];
      expect(entries).toHaveLength(1);
    });

    it("bypassUserLimit=true publishes every item without limiter calls", async () => {
      const work = Array.from({ length: 20 }, (_, i) => ({
        kind: "isbn" as const,
        isbn: `978000000${i.toString().padStart(4, "0")}`,
      }));
      await scheduleCatalogResolveIfAllowed("svc", work, {
        bypassUserLimit: true,
      });
      expect(userLimitMock).not.toHaveBeenCalled();
      const entries = batchJSONSpy.mock.calls[0]![0] as unknown[];
      expect(entries).toHaveLength(20);
    });

    it("empty work → no publish", async () => {
      await scheduleCatalogResolveIfAllowed("u", [], { bypassUserLimit: true });
      expect(batchJSONSpy).not.toHaveBeenCalled();
    });

    it("batchJSON throws → no exception escapes (cosmetic enrichment posture)", async () => {
      batchJSONSpy.mockRejectedValueOnce(new Error("qstash unreachable"));
      await expect(
        scheduleCatalogResolveIfAllowed("u", [
          { kind: "isbn", isbn: "9780000000000" },
        ]),
      ).resolves.toBeUndefined();
      expect(sentryCaptureSpy).toHaveBeenCalledTimes(1);
      expect(sentryCaptureSpy.mock.calls[0][1]).toMatchObject({
        tags: { queue: "catalog-resolve", phase: "publish" },
      });
    });
  });
});
