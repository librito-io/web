import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  COVER_STORAGE_BACKEND: "supabase",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  UPSTASH_REDIS_REST_URL: "https://mock-upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
  PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc",
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => supabase }));

const runInBackgroundSpy = vi.fn();
vi.mock("$lib/server/wait-until", () => ({
  runInBackground: runInBackgroundSpy,
}));

const { GET } =
  await import("../../src/routes/api/book-catalog/[isbn]/+server");

beforeEach(() => {
  supabase._results.clear();
  runInBackgroundSpy.mockClear();
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
});
