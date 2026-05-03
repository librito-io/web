import { describe, it, expect, vi } from "vitest";
import {
  fetchGoogleBooksByIsbn,
  fetchGoogleBooksByTitleAuthor,
  fetchGoogleBooksCoverBytes,
} from "../../../src/lib/server/catalog/googlebooks";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchGoogleBooksByIsbn", () => {
  it("hits the volumes endpoint with isbn: query", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ items: [{ id: "x", volumeInfo: {} }] }),
    );
    const r = await fetchGoogleBooksByIsbn("9780743273565", { fetchFn });
    expect(r?.id).toBe("x");
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringMatching(/q=isbn:9780743273565/),
      expect.any(Object),
    );
  });

  it("returns null when items missing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));
    expect(
      await fetchGoogleBooksByIsbn("9780000000002", { fetchFn }),
    ).toBeNull();
  });

  it("forwards the API key when provided", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ items: [] }));
    await fetchGoogleBooksByIsbn("9780743273565", { fetchFn, apiKey: "k" });
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringMatching(/key=k/),
      expect.any(Object),
    );
  });
});

describe("fetchGoogleBooksByTitleAuthor", () => {
  it("URL-encodes the intitle and inauthor params", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ items: [] }));
    await fetchGoogleBooksByTitleAuthor(
      "The Great Gatsby",
      "F. Scott Fitzgerald",
      { fetchFn },
    );
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringMatching(/intitle:The%20Great%20Gatsby/),
      expect.any(Object),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringMatching(/inauthor:F.%20Scott%20Fitzgerald/),
      expect.any(Object),
    );
  });
});

describe("fetchGoogleBooksCoverBytes", () => {
  it("upgrades http: to https: and fetches", async () => {
    const bytes = new Uint8Array(1024).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const r = await fetchGoogleBooksCoverBytes("http://example.com/cover.jpg", {
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/cover.jpg",
      expect.any(Object),
    );
    expect(r?.bytes.byteLength).toBe(1024);
    expect(r?.mime).toBe("image/jpeg");
  });

  it("returns null when response body is below the 512-byte threshold", async () => {
    const bytes = new Uint8Array(256).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    expect(
      await fetchGoogleBooksCoverBytes("https://example.com/cover.jpg", {
        fetchFn,
      }),
    ).toBeNull();
  });

  it("returns null on 404", async () => {
    const fetchFn = vi.fn(
      async () => new Response(new Uint8Array(0), { status: 404 }),
    );
    expect(
      await fetchGoogleBooksCoverBytes("https://example.com/cover.jpg", {
        fetchFn,
      }),
    ).toBeNull();
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
    expect(
      await fetchGoogleBooksCoverBytes("https://example.com/cover.jpg", {
        fetchFn,
      }),
    ).toBeNull();
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
    expect(
      await fetchGoogleBooksCoverBytes("https://example.com/cover.jpg", {
        fetchFn,
      }),
    ).toBeNull();
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
    const r = await fetchGoogleBooksCoverBytes(
      "https://example.com/cover.jpg",
      { fetchFn },
    );
    expect(r).not.toBeNull();
    expect(r?.bytes.byteLength).toBe(200 * 1024);
  });
});
