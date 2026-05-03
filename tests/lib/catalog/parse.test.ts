// tests/lib/catalog/parse.test.ts
import { describe, it, expect } from "vitest";
import { parseIsbnsFromBody } from "$lib/server/catalog/parse";

function makeRequest(body: unknown, contentType = "application/json"): Request {
  return new Request("http://x/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

describe("parseIsbnsFromBody", () => {
  it("returns null when content-type is not application/json", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ isbns: ["9780743273565"] }),
    });
    expect(await parseIsbnsFromBody(req)).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });
    expect(await parseIsbnsFromBody(req)).toBeNull();
  });

  it("returns null when isbns key is missing", async () => {
    const req = makeRequest({ other: "data" });
    expect(await parseIsbnsFromBody(req)).toBeNull();
  });

  it("returns null when isbns is not an array", async () => {
    const req = makeRequest({ isbns: "not-an-array" });
    expect(await parseIsbnsFromBody(req)).toBeNull();
  });

  it("returns canonicalized list for valid ISBN-13 strings", async () => {
    const req = makeRequest({
      isbns: ["9780743273565", "9780451524935"],
    });
    const result = await parseIsbnsFromBody(req);
    expect(result).toEqual(["9780743273565", "9780451524935"]);
  });

  it("converts valid ISBN-10 to ISBN-13", async () => {
    // ISBN-10 0451524934 → ISBN-13 9780451524935
    const req = makeRequest({ isbns: ["0451524934"] });
    const result = await parseIsbnsFromBody(req);
    expect(result).toEqual(["9780451524935"]);
  });

  it("filters out non-string entries", async () => {
    const req = makeRequest({ isbns: [42, null, "9780743273565"] });
    const result = await parseIsbnsFromBody(req);
    expect(result).toEqual(["9780743273565"]);
  });

  it("filters out strings that are not valid ISBNs", async () => {
    const req = makeRequest({
      isbns: ["not-an-isbn", "9780743273565", "000"],
    });
    const result = await parseIsbnsFromBody(req);
    expect(result).toEqual(["9780743273565"]);
  });

  it("returns empty array when isbns is an empty array", async () => {
    // Preserves original inline behavior: [] is truthy in JS so an empty
    // body array uses "body" source (no fall-through to NYT default).
    const req = makeRequest({ isbns: [] });
    const result = await parseIsbnsFromBody(req);
    expect(result).toEqual([]);
  });

  it("returns empty array when all entries fail canonicalization", async () => {
    // Same as above — caller sees [] (truthy), picks "body" source, no ISBNs resolved.
    const req = makeRequest({ isbns: ["invalid", "also-bad"] });
    const result = await parseIsbnsFromBody(req);
    expect(result).toEqual([]);
  });
});
