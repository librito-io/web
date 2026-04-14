import { describe, it, expect } from "vitest";
import { validateSyncPayload } from "$lib/server/sync";

describe("validateSyncPayload", () => {
  it("accepts a valid empty payload", () => {
    const result = validateSyncPayload({ lastSyncedAt: 0, books: [] });
    expect("payload" in result).toBe(true);
  });

  it("accepts a valid payload with one book and highlight", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 1712345678,
      books: [
        {
          bookHash: "da4c5f2e",
          title: "Test Book",
          highlights: [
            { chapter: 3, startWord: 100, endWord: 150, text: "Some text" },
          ],
        },
      ],
    });
    expect("payload" in result).toBe(true);
  });

  it("rejects non-object body", () => {
    const result = validateSyncPayload("not an object");
    expect(result).toEqual({ error: expect.stringContaining("object") });
  });

  it("rejects missing lastSyncedAt", () => {
    const result = validateSyncPayload({ books: [] });
    expect(result).toEqual({ error: expect.stringContaining("lastSyncedAt") });
  });

  it("rejects negative lastSyncedAt", () => {
    const result = validateSyncPayload({ lastSyncedAt: -1, books: [] });
    expect(result).toEqual({ error: expect.stringContaining("lastSyncedAt") });
  });

  it("rejects non-integer lastSyncedAt", () => {
    const result = validateSyncPayload({ lastSyncedAt: 1.5, books: [] });
    expect(result).toEqual({ error: expect.stringContaining("lastSyncedAt") });
  });

  it("rejects missing books array", () => {
    const result = validateSyncPayload({ lastSyncedAt: 0 });
    expect(result).toEqual({ error: expect.stringContaining("books") });
  });

  it("rejects invalid bookHash format", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [{ bookHash: "xyz", highlights: [] }],
    });
    expect(result).toEqual({ error: expect.stringContaining("bookHash") });
  });

  it("rejects highlight with endWord <= startWord", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            { chapter: 0, startWord: 100, endWord: 50, text: "Bad range" },
          ],
        },
      ],
    });
    expect(result).toEqual({ error: expect.stringContaining("endWord") });
  });

  it("rejects highlight with empty text", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [{ chapter: 0, startWord: 0, endWord: 10, text: "" }],
        },
      ],
    });
    expect(result).toEqual({ error: expect.stringContaining("text") });
  });

  it("accepts valid deletedHighlights", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [],
          deletedHighlights: [{ chapter: 1, startWord: 10, endWord: 20 }],
        },
      ],
    });
    expect("payload" in result).toBe(true);
  });

  it("rejects invalid deletedHighlights entry", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [],
          deletedHighlights: [{ chapter: -1, startWord: 10, endWord: 20 }],
        },
      ],
    });
    expect(result).toEqual({ error: expect.stringContaining("chapter") });
  });
});
