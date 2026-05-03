import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";
import { FAIL_CLOSED_RETRY_AFTER_SEC } from "$lib/server/ratelimit.constants";

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
vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => supabase }));

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

const { GET } =
  await import("../../src/routes/api/book-catalog/[isbn]/+server");

beforeEach(() => {
  supabase._results.clear();
  runInBackgroundSpy.mockClear();
  userLimitMock.mockReset();
  userLimitMock.mockResolvedValue({
    success: true,
    reset: Date.now() + 60_000,
    limit: 10,
    remaining: 9,
    pending: Promise.resolve(),
  });
});

function buildEvent(isbn: string, session: unknown = { user: { id: "u1" } }) {
  return {
    params: { isbn },
    locals: { safeGetSession: async () => session },
    platform: { context: { waitUntil: vi.fn() } },
    url: new URL(`https://example.com/api/book-catalog/${isbn}`),
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /api/book-catalog/[isbn]", () => {
  it("401 when unauthenticated", async () => {
    const res = await GET(buildEvent("9780743273565", { user: null }));
    expect(res.status).toBe(401);
  });

  it("400 on invalid ISBN", async () => {
    const res = await GET(buildEvent("00000"));
    expect(res.status).toBe(400);
  });

  it("returns existing row with cover_url", async () => {
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: "9780743273565",
          title: "Gatsby",
          author: "Fitzgerald",
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
          description: "...",
        },
      ],
      error: null,
    });
    const res = await GET(buildEvent("9780743273565"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.cover_url).toContain(
      "storage/v1/object/public/cover-cache/ab/cd.jpg",
    );
    expect(body.title).toBe("Gatsby");
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("returns placeholder + triggers waitUntil on cold miss", async () => {
    supabase._results.set("book_catalog.select", { data: [], error: null });
    const res = await GET(buildEvent("9780743273565"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.cover_url).toBe("/cover-placeholder.svg");
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
  });

  it("429 with Retry-After when per-user limiter denies on cold miss", async () => {
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
      limit: 10,
      remaining: 0,
      pending: Promise.resolve(),
    });
    const res = await GET(buildEvent("9780743273565"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("does not call per-user limiter on hit path (warm catalog row)", async () => {
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: "9780743273565",
          title: "Gatsby",
          author: "Fitzgerald",
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });
    // Configure limiter to deny — must be irrelevant on the hit path.
    userLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 30_000,
      limit: 10,
      remaining: 0,
      pending: Promise.resolve(),
    });
    const res = await GET(buildEvent("9780743273565"));
    expect(res.status).toBe(200);
    expect(userLimitMock).not.toHaveBeenCalled();
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("hit response includes all 12 metadata fields", async () => {
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: "9780743273565",
          title: "The Great Gatsby",
          author: "F. Scott Fitzgerald",
          description: "A novel about the Jazz Age",
          description_provider: "openlibrary",
          publisher: "Scribner",
          page_count: 180,
          subjects: ["fiction", "classic"],
          published_date: "1925-04-10",
          language: "en",
          series_name: null,
          series_position: null,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });
    const res = await GET(buildEvent("9780743273565"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isbn).toBe("9780743273565");
    expect(body.title).toBe("The Great Gatsby");
    expect(body.author).toBe("F. Scott Fitzgerald");
    expect(body.description).toBe("A novel about the Jazz Age");
    expect(body.description_provider).toBe("openlibrary");
    expect(body.publisher).toBe("Scribner");
    expect(body.page_count).toBe(180);
    expect(body.subjects).toEqual(["fiction", "classic"]);
    expect(body.published_date).toBe("1925-04-10");
    expect(body.language).toBe("en");
    expect(body.series_name).toBeNull();
    expect(body.series_position).toBeNull();
    expect(body.cold_miss).toBe(false);
    expect(body.cover_url).toContain(
      "storage/v1/object/public/cover-cache/ab/cd.jpg",
    );
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
  });

  it("cold-miss response includes all 12 metadata fields (negative-cache row)", async () => {
    // Negative-cache row: exists in DB but has no cover stored yet.
    // All metadata fields present; cover_url is null because storage_path is null.
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: "9780743273565",
          title: "The Great Gatsby",
          author: "F. Scott Fitzgerald",
          description: "A novel about the Jazz Age",
          description_provider: "openlibrary",
          publisher: "Scribner",
          page_count: 180,
          subjects: ["fiction", "classic"],
          published_date: "1925-04-10",
          language: "en",
          series_name: null,
          series_position: null,
          storage_path: null,
          cover_storage_backend: null,
        },
      ],
      error: null,
    });
    const res = await GET(buildEvent("9780743273565"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isbn).toBe("9780743273565");
    expect(body.title).toBe("The Great Gatsby");
    expect(body.author).toBe("F. Scott Fitzgerald");
    expect(body.description).toBe("A novel about the Jazz Age");
    expect(body.description_provider).toBe("openlibrary");
    expect(body.publisher).toBe("Scribner");
    expect(body.page_count).toBe(180);
    expect(body.subjects).toEqual(["fiction", "classic"]);
    expect(body.published_date).toBe("1925-04-10");
    expect(body.language).toBe("en");
    expect(body.series_name).toBeNull();
    expect(body.series_position).toBeNull();
    expect(body.cold_miss).toBe(true);
    expect(body.cover_url).toBe("/cover-placeholder.svg");
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
  });

  it("schedules runInBackground when limiter allows on cold miss", async () => {
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
      limit: 10,
      remaining: 9,
      pending: Promise.resolve(),
    });
    const res = await GET(buildEvent("9780743273565"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cold_miss).toBe(true);
    expect(userLimitMock).toHaveBeenCalledTimes(1);
    expect(userLimitMock).toHaveBeenCalledWith("u1");
    expect(runInBackgroundSpy).toHaveBeenCalledTimes(1);
  });

  it("503 when per-user limiter fail-closes on Upstash outage", async () => {
    supabase._results.set("book_catalog.select", { data: [], error: null });
    userLimitMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(buildEvent("9780743273565"));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(
      String(FAIL_CLOSED_RETRY_AFTER_SEC),
    );
    expect(runInBackgroundSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
