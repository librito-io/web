// Unit tests for the admin catalog search page load in
// src/routes/app/admin/+page.server.ts.
//
// Regression context:
//   - Real catalog row stored as title='The Handmaid\'s Tale' (straight U+0027).
//   - User search for "Handmaid" returned no hits because the .or filter
//     used prefix `ilike '${q}%'` not substring.
//   - User paste of "The Handmaid’s Tale" (curly U+2019) returned no hits
//     because sanitizeQuery's whitelist stripped the curly apostrophe,
//     transforming the term to "The Handmaids Tale" which no longer
//     prefix-matched the stored straight-apostrophe title.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock-upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({ env: {} }));
vi.mock("$env/dynamic/public", () => ({ env: {} }));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => supabase }));

const { load } = await import("../../src/routes/app/admin/+page.server");

function buildEvent(q: string | null) {
  const url = new URL("https://example.com/app/admin");
  if (q !== null) url.searchParams.set("q", q);
  return {
    url,
    request: new Request(url),
    route: { id: "/app/admin" },
  } as unknown as Parameters<typeof load>[0];
}

function getOrFilter(): string | undefined {
  const call = supabase._chainCalls.find(
    (c) => c.table === "book_catalog" && c.method === "or",
  );
  return call?.args[0] as string | undefined;
}

beforeEach(() => {
  supabase._results.clear();
  supabase._chainCalls.length = 0;
  supabase._results.set("book_catalog.select", { data: [], error: null });
});

describe("load /app/admin — query sanitisation", () => {
  it("returns empty results without hitting DB when q is missing", async () => {
    const result = await load(buildEvent(null));
    expect(result).toEqual({ q: "", results: [] });
    expect(getOrFilter()).toBeUndefined();
  });

  it("returns empty results when q sanitises to empty string", async () => {
    const result = (await load(buildEvent("@@@%%%"))) as {
      q: string;
      results: unknown[];
    };
    expect(result.results).toEqual([]);
    expect(getOrFilter()).toBeUndefined();
  });
});

describe("load /app/admin — filter shape", () => {
  it("uses substring (leading + trailing %) so mid-title hits match", async () => {
    await load(buildEvent("Handmaid"));
    const or = getOrFilter();
    expect(or).toBe(
      "isbn.ilike.%Handmaid%,title.ilike.%Handmaid%,author.ilike.%Handmaid%",
    );
  });

  it("normalises curly apostrophes (U+2019) to straight (U+0027) before filtering", async () => {
    await load(buildEvent("The Handmaid’s Tale"));
    const or = getOrFilter();
    expect(or).toBe(
      "isbn.ilike.%The Handmaid's Tale%,title.ilike.%The Handmaid's Tale%,author.ilike.%The Handmaid's Tale%",
    );
  });

  it("normalises curly opening apostrophe (U+2018) to straight", async () => {
    await load(buildEvent("‘test’"));
    const or = getOrFilter();
    expect(or).toBe(
      "isbn.ilike.%'test'%,title.ilike.%'test'%,author.ilike.%'test'%",
    );
  });
});
