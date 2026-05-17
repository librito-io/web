import { describe, it, expect, vi } from "vitest";
import {
  fetchItunesByIsbn,
  upgradeArtworkUrl,
} from "../../../src/lib/server/catalog/itunes";

describe("upgradeArtworkUrl", () => {
  it("rewrites 100x100bb to 2400x2400bb", () => {
    const out = upgradeArtworkUrl(
      "https://is3-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg",
    );
    expect(out).toBe(
      "https://is3-ssl.mzstatic.com/image/thumb/abc/2400x2400bb.jpg",
    );
  });

  it("handles other size patterns in the URL", () => {
    const out = upgradeArtworkUrl(
      "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/abc/source/60x60bb.png",
    );
    expect(out).toContain("2400x2400bb");
  });

  it("returns input unchanged when no size pattern matches", () => {
    const raw = "https://example.com/no-pattern.jpg";
    expect(upgradeArtworkUrl(raw)).toBe(raw);
  });
});

describe("fetchItunesByIsbn", () => {
  it("returns the first result when iTunes finds the ISBN", async () => {
    const body = {
      resultCount: 1,
      results: [
        {
          artistName: "Author",
          trackName: "Title",
          artworkUrl100:
            "https://is3-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg",
        },
      ],
    };
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await fetchItunesByIsbn("9780000000000", { fetchFn });
    expect(result?.artworkUrl100).toContain("100x100bb");
  });

  it("returns null on empty results", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await fetchItunesByIsbn("9780000000000", { fetchFn })).toBeNull();
  });

  it("returns null when iTunes returns 404", async () => {
    const fetchFn = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    expect(await fetchItunesByIsbn("9780000000000", { fetchFn })).toBeNull();
  });

  it("URL-encodes the ISBN parameter", async () => {
    let capturedUrl: string | null = null;
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await fetchItunesByIsbn("9780000000000", { fetchFn });
    expect(capturedUrl).toBe(
      "https://itunes.apple.com/lookup?isbn=9780000000000",
    );
  });
});
