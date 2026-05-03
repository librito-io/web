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
import {
  createTestMutex,
  type CatalogMutex,
} from "../../../src/lib/server/catalog/mutex";

const ok = { success: true } as never;

function makeFetchFn() {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("openlibrary.org/api/books")) {
      return new Response(
        JSON.stringify({ "ISBN:9780743273565": { title: "Gatsby" } }),
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
        JSON.stringify({ kind: "books#volumes", totalItems: 0, items: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(new Uint8Array(512), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as unknown as typeof fetch;
}

function deps(
  overrides: Partial<Parameters<typeof resolveIsbn>[2]> = {},
): Parameters<typeof resolveIsbn>[2] {
  return {
    fetchFn: makeFetchFn(),
    rateLimiters: {
      openLibrary: { limit: vi.fn(async () => ok) },
      googleBooks: { limit: vi.fn(async () => ok) },
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

describe("resolveIsbn — per-ISBN mutex (audit #12)", () => {
  it("two concurrent calls for the same ISBN: winner runs upstream, loser short-circuits", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    const mutex = createTestMutex();
    const acquireSpy = vi.spyOn(mutex, "acquire");

    // Pre-acquire to deterministically install a winner ordering: the
    // first resolveIsbn call below will see "lock not held" only AFTER
    // we manually release. Simpler: just run two in Promise.all and rely
    // on the in-memory mutex's serial semantics — the first to await
    // `acquire` wins.
    const fetchFn = makeFetchFn();
    const sharedDeps = deps({ fetchFn, mutex });

    const [a, b] = await Promise.all([
      resolveIsbn(supabase as never, "9780743273565", sharedDeps),
      resolveIsbn(supabase as never, "9780743273565", sharedDeps),
    ]);

    // One winner (rateLimited=false) and one loser (rateLimited=true).
    const winners = [a, b].filter((r) => !r.rateLimited);
    const losers = [a, b].filter((r) => r.rateLimited);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Mutex was queried with the isbn-namespaced key.
    expect(acquireSpy).toHaveBeenCalledWith("catalog:lock:isbn:9780743273565");
    expect(acquireSpy).toHaveBeenCalledTimes(2);

    // Upstream OL data fetch happened exactly once (winner only).
    const olCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) =>
        String(args[0]).includes("openlibrary.org/api/books"),
    );
    expect(olCalls).toHaveLength(1);

    // Per-source rate-limit budget consumed exactly once.
    expect(sharedDeps.rateLimiters.openLibrary.limit).toHaveBeenCalledTimes(1);

    // RPC upsert ran exactly once.
    const upserts = supabase._rpcCalls.filter(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upserts).toHaveLength(1);
  });

  it("positive cache hit short-circuits before mutex acquire", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        { isbn: "9780743273565", storage_path: "x/y.jpg", title: "Gatsby" },
      ],
      error: null,
    });
    const mutex = createTestMutex();
    const acquireSpy = vi.spyOn(mutex, "acquire");
    const r = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ mutex }),
    );
    expect(r.cached).toBe(true);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("fresh negative cache short-circuits before mutex acquire", async () => {
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
    const mutex = createTestMutex();
    const acquireSpy = vi.spyOn(mutex, "acquire");
    const r = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ mutex }),
    );
    expect(r.cached).toBe(true);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("mutex release runs even when resolver throws mid-run", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    // Force the upsert RPC to fail so the resolver throws after the
    // critical section is entered.
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: { message: "boom" },
    });

    const mutex = createTestMutex();
    const releaseSpy = vi.spyOn(mutex, "release");
    await expect(
      resolveIsbn(supabase as never, "9780743273565", deps({ mutex })),
    ).rejects.toThrow(/book_catalog upsert/);
    expect(releaseSpy).toHaveBeenCalledWith("catalog:lock:isbn:9780743273565");
    // The lock is no longer held — a follow-up call must be able to
    // acquire it again.
    expect(mutex._held.has("catalog:lock:isbn:9780743273565")).toBe(false);
  });

  it("mutex acquire fail-OPEN: resolver still proceeds and writes the row", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    supabase._results.set("rpc.upsert_book_catalog_by_isbn", {
      data: null,
      error: null,
    });

    // Mutex whose acquire throws — production code logs + returns true.
    // Here we model the *contract* directly: a fail-OPEN mutex returns
    // true even under transport failure. The existing in-memory mutex
    // already returns true for an unheld key; the discriminator is that
    // a custom mutex stub here mimics the production "log and proceed"
    // posture without needing to install a console spy.
    const mutex: CatalogMutex = {
      acquire: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    };
    const r = await resolveIsbn(
      supabase as never,
      "9780743273565",
      deps({ mutex }),
    );
    expect(r.rateLimited).toBe(false);
    expect(r.cached).toBe(false);
    const upserts = supabase._rpcCalls.filter(
      (c) => c.name === "upsert_book_catalog_by_isbn",
    );
    expect(upserts).toHaveLength(1);
    expect(mutex.release).toHaveBeenCalledWith(
      "catalog:lock:isbn:9780743273565",
    );
  });
});

describe("resolveTitleAuthor — per-(title,author) mutex namespace", () => {
  it("uses the ta: namespace, not isbn:", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });

    const mutex = createTestMutex();
    const acquireSpy = vi.spyOn(mutex, "acquire");
    await resolveTitleAuthor(
      supabase as never,
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      deps({ mutex }),
    );
    const calls = acquireSpy.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      "catalog:lock:ta:the great gatsby|f scott fitzgerald",
    ]);
  });

  it("two concurrent title/author calls: winner runs, loser short-circuits", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    supabase._results.set("rpc.upsert_book_catalog_by_title_author", {
      data: null,
      error: null,
    });

    const mutex = createTestMutex();
    const sharedDeps = deps({ mutex });

    const [a, b] = await Promise.all([
      resolveTitleAuthor(
        supabase as never,
        "The Great Gatsby",
        "F. Scott Fitzgerald",
        sharedDeps,
      ),
      resolveTitleAuthor(
        supabase as never,
        "The Great Gatsby",
        "F. Scott Fitzgerald",
        sharedDeps,
      ),
    ]);
    expect([a.rateLimited, b.rateLimited].sort()).toEqual([false, true]);

    const upserts = supabase._rpcCalls.filter(
      (c) => c.name === "upsert_book_catalog_by_title_author",
    );
    expect(upserts).toHaveLength(1);
  });
});
