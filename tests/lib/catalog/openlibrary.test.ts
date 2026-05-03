import { describe, it, expect, vi } from "vitest";
import {
  fetchOpenLibraryByIsbn,
  searchOpenLibraryByIsbn,
  fetchOpenLibraryWork,
  fetchOpenLibraryCoverBytes,
} from "../../../src/lib/server/catalog/openlibrary";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchOpenLibraryByIsbn", () => {
  it("calls /api/books with bibkeys and returns the matching doc", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        "ISBN:9780743273565": {
          title: "Gatsby",
          works: [{ key: "/works/OL1W" }],
        },
      }),
    );
    const result = await fetchOpenLibraryByIsbn("9780743273565", { fetchFn });
    expect(result?.title).toBe("Gatsby");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openlibrary.org/api/books?bibkeys=ISBN:9780743273565&format=json&jscmd=data",
      expect.any(Object),
    );
  });

  it("returns null on 404 / missing key", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));
    expect(
      await fetchOpenLibraryByIsbn("9780000000002", { fetchFn }),
    ).toBeNull();
  });

  it("throws on non-2xx", async () => {
    const fetchFn = vi.fn(async () => new Response("oops", { status: 500 }));
    await expect(
      fetchOpenLibraryByIsbn("9780743273565", { fetchFn }),
    ).rejects.toThrow();
  });
});

describe("searchOpenLibraryByIsbn", () => {
  it("returns the first doc with cover_i", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ docs: [{ cover_i: 12345, title: "Gatsby" }] }),
    );
    const r = await searchOpenLibraryByIsbn("9780743273565", { fetchFn });
    expect(r?.cover_i).toBe(12345);
  });
});

describe("fetchOpenLibraryWork", () => {
  it("hits /works/{id}.json", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ description: "..." }));
    await fetchOpenLibraryWork("OL1W", { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openlibrary.org/works/OL1W.json",
      expect.any(Object),
    );
  });
});

describe("fetchOpenLibraryCoverBytes", () => {
  it("returns bytes when 200 and body is above the placeholder threshold", async () => {
    const bytes = new Uint8Array(2048).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const r = await fetchOpenLibraryCoverBytes(12345, { fetchFn });
    expect(r?.bytes.byteLength).toBe(2048);
    expect(r?.mime).toBe("image/jpeg");
  });

  it("returns null when response body is below the 1024-byte placeholder threshold (Open Library serves ~807-byte placeholder for unknown covers)", async () => {
    const bytes = new Uint8Array(500).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    expect(await fetchOpenLibraryCoverBytes(99999, { fetchFn })).toBeNull();
  });

  it("returns null on 404", async () => {
    const fetchFn = vi.fn(
      async () => new Response(new Uint8Array(0), { status: 404 }),
    );
    expect(await fetchOpenLibraryCoverBytes(0, { fetchFn })).toBeNull();
  });

  it("returns null when Content-Length header exceeds 5 MB cap", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(new Uint8Array(512).fill(0xff), {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": "6000000",
          },
        }),
    );
    expect(await fetchOpenLibraryCoverBytes(12345, { fetchFn })).toBeNull();
  });

  it("returns null when body exceeds 5 MB cap with no Content-Length header (post-buffer backstop)", async () => {
    const oversizeBody = new Uint8Array(6 * 1024 * 1024).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(oversizeBody, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    // Verify our test fixture has no content-length (Node Response doesn't auto-set it for Uint8Array)
    const testRes = await fetchFn();
    expect(testRes.headers.get("content-length")).toBeNull();
    expect(await fetchOpenLibraryCoverBytes(12345, { fetchFn })).toBeNull();
  });

  it("returns bytes for a realistic-size cover (200 KB) — cap does not false-positive", async () => {
    const realisticCover = new Uint8Array(200 * 1024).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(realisticCover, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const r = await fetchOpenLibraryCoverBytes(12345, { fetchFn });
    expect(r).not.toBeNull();
    expect(r?.bytes.byteLength).toBe(200 * 1024);
  });
});
