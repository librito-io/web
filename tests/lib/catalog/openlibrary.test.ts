import { describe, it, expect, vi } from "vitest";
import {
  fetchOpenLibraryByIsbn,
  searchOpenLibraryByIsbn,
  fetchOpenLibraryWork,
  fetchOpenLibraryCoverBytes,
  fetchOpenLibraryCoverBytesByIsbn,
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
  it("requests OL cover with default=false to suppress -M downgrade", async () => {
    let capturedUrl: string | null = null;
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(new Uint8Array(2048), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": "2048",
        },
      });
    });
    await fetchOpenLibraryCoverBytes(12345, { fetchFn });
    expect(capturedUrl).toBe(
      "https://covers.openlibrary.org/b/id/12345-L.jpg?default=false",
    );
  });

  it("returns bytes when 200 and body is above the placeholder threshold", async () => {
    const bytes = new Uint8Array(2048).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    // coverId is baked into the URL (covers.openlibrary.org), which is in the allowedHosts list.
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

describe("fetchOpenLibraryCoverBytesByIsbn", () => {
  // PNG signature + IHDR with width 600 (0x0258), height 900 (0x0384), padded
  // above the 1024-byte placeholder floor so byteSize check passes; decoder
  // reads dimensions from offset 16-23 (IHDR), trailing zeros are ignored.
  function pngBytes(
    widthBE: number[],
    heightBE: number[],
  ): Uint8Array<ArrayBuffer> {
    const header = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      ...widthBE,
      ...heightBE,
    ]);
    const padded = new Uint8Array(2048);
    padded.set(header, 0);
    return padded;
  }

  it("calls covers.openlibrary.org/b/isbn/{isbn}-L.jpg?default=false", async () => {
    const png = pngBytes(
      [0x00, 0x00, 0x02, 0x58], // width 600
      [0x00, 0x00, 0x03, 0x84], // height 900
    );
    const seen: string[] = [];
    const fetchFn = vi.fn(async (u: URL | RequestInfo) => {
      seen.push(typeof u === "string" ? u : u.toString());
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    const result = await fetchOpenLibraryCoverBytesByIsbn("9780000000001", {
      fetchFn,
    });
    expect(result).not.toBeNull();
    expect(seen[0]).toBe(
      "https://covers.openlibrary.org/b/isbn/9780000000001-L.jpg?default=false",
    );
  });

  it("returns null on 404", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await fetchOpenLibraryCoverBytesByIsbn("9780000000001", {
      fetchFn,
    });
    expect(result).toBeNull();
  });

  it("rejects when decoded width < minWidth floor", async () => {
    const png = pngBytes(
      [0x00, 0x00, 0x00, 0x64], // width 100
      [0x00, 0x00, 0x00, 0x96], // height 150
    );
    const fetchFn = vi.fn(
      async () =>
        new Response(png, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const result = await fetchOpenLibraryCoverBytesByIsbn("9780000000001", {
      fetchFn,
      minWidth: 300,
    });
    expect(result).toBeNull();
  });
});

describe("searchOpenLibraryWorksByTitleAuthor", () => {
  it("requests limit=10 with ranking fields and returns the docs array", async () => {
    const { searchOpenLibraryWorksByTitleAuthor } =
      await import("../../../src/lib/server/catalog/openlibrary");

    let calledUrl = "";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      calledUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({
        docs: [
          {
            key: "/works/OL1W",
            title: "A",
            edition_count: 5,
            first_publish_year: 2001,
          },
          {
            key: "/works/OL2W",
            title: "A",
            edition_count: 1,
            first_publish_year: 2020,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const docs = await searchOpenLibraryWorksByTitleAuthor("A", "B", {
      fetchFn,
    });
    expect(calledUrl).toContain("limit=10");
    expect(calledUrl).toContain("edition_count");
    expect(calledUrl).toContain("first_publish_year");
    expect(docs).toHaveLength(2);
    expect(docs[0].key).toBe("/works/OL1W");
  });

  it("returns [] when the response has no docs", async () => {
    const { searchOpenLibraryWorksByTitleAuthor } =
      await import("../../../src/lib/server/catalog/openlibrary");

    const fetchFn = vi.fn(async () =>
      jsonResponse({}),
    ) as unknown as typeof fetch;
    expect(
      await searchOpenLibraryWorksByTitleAuthor("A", "B", { fetchFn }),
    ).toEqual([]);
  });
});

describe("fetchOpenLibraryEditions", () => {
  it("fetches editions for a work key and returns the parsed response", async () => {
    const { fetchOpenLibraryEditions } =
      await import("../../../src/lib/server/catalog/openlibrary");

    let calledUrl = "";
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      calledUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({
        entries: [{ covers: [111] }, { covers: [-1] }],
      });
    }) as unknown as typeof fetch;
    const res = await fetchOpenLibraryEditions("OL1W", { fetchFn });
    expect(calledUrl).toContain("/works/OL1W/editions.json");
    expect(calledUrl).toContain("limit=20");
    expect(res?.entries?.[0].covers).toEqual([111]);
  });

  it("returns null on 404", async () => {
    const { fetchOpenLibraryEditions } =
      await import("../../../src/lib/server/catalog/openlibrary");

    const fetchFn = vi.fn(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await fetchOpenLibraryEditions("OLX", { fetchFn })).toBeNull();
  });
});
