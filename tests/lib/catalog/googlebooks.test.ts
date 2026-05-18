import { describe, it, expect, vi } from "vitest";
import {
  fetchGoogleBooksByIsbn,
  fetchGoogleBooksByTitleAuthor,
  fetchGoogleBooksCoverBytes,
  selectBestGoogleImageLink,
  massageGoogleBooksCoverUrl,
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

describe("fetchGoogleBooksByIsbn — accessInfo flow-through", () => {
  it("returns accessInfo when present in API response", async () => {
    const apiResponse = {
      items: [
        {
          id: "TESTVOLID",
          volumeInfo: { title: "Test", imageLinks: { thumbnail: "http://x" } },
          accessInfo: {
            viewability: "PARTIAL",
            pdf: { isAvailable: false },
          },
        },
      ],
    };
    const fetchFn = vi.fn(async () => jsonResponse(apiResponse));
    const result = await fetchGoogleBooksByIsbn("9780000000001", {
      fetchFn,
    });
    expect(result?.accessInfo?.pdf?.isAvailable).toBe(false);
    expect(result?.accessInfo?.viewability).toBe("PARTIAL");
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
    const r = await fetchGoogleBooksCoverBytes(
      "http://books.google.com/cover.jpg",
      { fetchFn },
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "https://books.google.com/cover.jpg?zoom=0",
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
      await fetchGoogleBooksCoverBytes("https://books.google.com/cover.jpg", {
        fetchFn,
      }),
    ).toBeNull();
  });

  it("returns null on 404", async () => {
    const fetchFn = vi.fn(
      async () => new Response(new Uint8Array(0), { status: 404 }),
    );
    expect(
      await fetchGoogleBooksCoverBytes("https://books.google.com/cover.jpg", {
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
      await fetchGoogleBooksCoverBytes("https://books.google.com/cover.jpg", {
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
      await fetchGoogleBooksCoverBytes(
        "https://lh3.googleusercontent.com/cover.jpg",
        {
          fetchFn,
        },
      ),
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
      "https://lh3.googleusercontent.com/cover.jpg",
      { fetchFn },
    );
    expect(r).not.toBeNull();
    expect(r?.bytes.byteLength).toBe(200 * 1024);
  });
});

describe("selectBestGoogleImageLink", () => {
  it("prefers extraLarge over everything", () => {
    expect(
      selectBestGoogleImageLink({
        thumbnail: "t",
        small: "s",
        large: "l",
        extraLarge: "xl",
      }),
    ).toBe("xl");
  });

  it("falls back to large when extraLarge absent", () => {
    expect(
      selectBestGoogleImageLink({
        thumbnail: "t",
        small: "s",
        large: "l",
      }),
    ).toBe("l");
  });

  it("falls back to medium when large absent", () => {
    expect(
      selectBestGoogleImageLink({
        thumbnail: "t",
        small: "s",
        medium: "m",
      }),
    ).toBe("m");
  });

  it("falls back to small when medium absent", () => {
    expect(
      selectBestGoogleImageLink({
        thumbnail: "t",
        small: "s",
      }),
    ).toBe("s");
  });

  it("falls back to thumbnail when nothing else present", () => {
    expect(selectBestGoogleImageLink({ thumbnail: "t" })).toBe("t");
  });

  it("returns undefined on empty imageLinks", () => {
    expect(selectBestGoogleImageLink({})).toBeUndefined();
  });

  it("skips smallThumbnail (truly tiny, never useful)", () => {
    expect(selectBestGoogleImageLink({ smallThumbnail: "st" })).toBeUndefined();
  });
});

describe("massageGoogleBooksCoverUrl", () => {
  it("rewrites zoom=1 to zoom=0", () => {
    const out = massageGoogleBooksCoverUrl(
      "https://books.google.com/books?id=X&printsec=frontcover&img=1&zoom=1",
    );
    expect(out).toContain("zoom=0");
    expect(out).not.toContain("zoom=1");
  });

  it("strips edge=curl", () => {
    const out = massageGoogleBooksCoverUrl(
      "https://books.google.com/books?id=X&zoom=1&edge=curl",
    );
    expect(out).not.toContain("edge=curl");
  });

  it("inserts zoom=0 when zoom absent", () => {
    const out = massageGoogleBooksCoverUrl(
      "https://books.google.com/books?id=X&printsec=frontcover",
    );
    expect(out).toContain("zoom=0");
  });

  it("forces https on http URLs", () => {
    const out = massageGoogleBooksCoverUrl(
      "http://books.google.com/books?id=X&zoom=1",
    );
    expect(out.startsWith("https://")).toBe(true);
  });

  it("preserves the original URL when already at zoom=0 with no edge=curl on https", () => {
    const raw = "https://books.google.com/books?id=X&zoom=0";
    expect(massageGoogleBooksCoverUrl(raw)).toBe(raw);
  });

  it("preserves ?id=X when edge=curl is the first param", () => {
    const out = massageGoogleBooksCoverUrl(
      "https://books.google.com/books?edge=curl&id=X",
    );
    expect(out).toContain("?id=X");
    expect(out).not.toContain("&id=X");
    expect(out).not.toContain("edge=curl");
  });

  it("strips trailing ? when edge=curl was the only param", () => {
    const out = massageGoogleBooksCoverUrl(
      "https://books.google.com/books?edge=curl",
    );
    // After strip + zoom insertion, expect ?zoom=0 not &zoom=0 dangling-?
    expect(out).toBe("https://books.google.com/books?zoom=0");
  });
});
