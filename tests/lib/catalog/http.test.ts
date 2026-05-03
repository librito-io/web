import { describe, it, expect, vi } from "vitest";
import {
  fetchCatalogJson,
  downloadCover,
} from "../../../src/lib/server/catalog/http";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchCatalogJson", () => {
  it("returns the parsed body on 200", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ title: "Gatsby" }));
    const result = await fetchCatalogJson<{ title: string }>(
      "https://example.com/book",
      { fetchFn },
      "testprovider",
    );
    expect(result?.title).toBe("Gatsby");
  });

  it("returns null on 404", async () => {
    const fetchFn = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    const result = await fetchCatalogJson(
      "https://example.com/missing",
      { fetchFn },
      "testprovider",
    );
    expect(result).toBeNull();
  });

  it("throws on non-404 HTTP errors with source prefix in the message", async () => {
    const fetchFn = vi.fn(
      async () => new Response("server error", { status: 500 }),
    );
    await expect(
      fetchCatalogJson("https://example.com/book", { fetchFn }, "testprovider"),
    ).rejects.toThrow("testprovider 500");
  });

  it("throws on 503 with source prefix in the message", async () => {
    const fetchFn = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
    );
    await expect(
      fetchCatalogJson("https://example.com/book", { fetchFn }, "mylib"),
    ).rejects.toThrow("mylib 503");
  });
});

describe("downloadCover", () => {
  const baseOpts = {
    minBytes: 512,
    maxBytes: 5 * 1024 * 1024,
    source: "testprovider",
  };

  it("returns { bytes, mime } on success", async () => {
    const imageData = new Uint8Array(1024).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(imageData, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const r = await downloadCover("https://example.com/cover.jpg", {
      ...baseOpts,
      fetchFn,
    });
    expect(r).not.toBeNull();
    expect(r?.bytes.byteLength).toBe(1024);
    expect(r?.mime).toBe("image/jpeg");
  });

  it("returns null on non-ok response", async () => {
    const fetchFn = vi.fn(
      async () => new Response(new Uint8Array(0), { status: 404 }),
    );
    const r = await downloadCover("https://example.com/cover.jpg", {
      ...baseOpts,
      fetchFn,
    });
    expect(r).toBeNull();
  });

  it("rejects when Content-Length exceeds maxBytes without buffering (pre-check)", async () => {
    // The Response body would pass the min check, but Content-Length is over the cap.
    const fetchFn = vi.fn(
      async () =>
        new Response(new Uint8Array(1024).fill(0xff), {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": "6000000",
          },
        }),
    );
    const r = await downloadCover("https://example.com/cover.jpg", {
      ...baseOpts,
      fetchFn,
    });
    expect(r).toBeNull();
  });

  it("rejects when actual buffered length exceeds maxBytes (post-buffer backstop)", async () => {
    const oversizeBody = new Uint8Array(6 * 1024 * 1024).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(oversizeBody, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    // Confirm the fixture has no content-length (pre-check must not fire).
    const testRes = await fetchFn();
    expect(testRes.headers.get("content-length")).toBeNull();
    const r = await downloadCover("https://example.com/cover.jpg", {
      ...baseOpts,
      fetchFn,
    });
    expect(r).toBeNull();
  });

  it("rejects when buffered length is below minBytes", async () => {
    const tinyBody = new Uint8Array(128).fill(0xff);
    const fetchFn = vi.fn(
      async () =>
        new Response(tinyBody, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const r = await downloadCover("https://example.com/cover.jpg", {
      ...baseOpts,
      fetchFn,
    });
    expect(r).toBeNull();
  });

  it("defaults mime to image/jpeg when content-type header is absent", async () => {
    const imageData = new Uint8Array(1024).fill(0xff);
    const fetchFn = vi.fn(async () => new Response(imageData, { status: 200 }));
    const r = await downloadCover("https://example.com/cover.jpg", {
      ...baseOpts,
      fetchFn,
    });
    expect(r?.mime).toBe("image/jpeg");
  });
});
