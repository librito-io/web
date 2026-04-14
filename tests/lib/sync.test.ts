import { describe, it, expect } from "vitest";
import { validateSyncPayload, processSync } from "$lib/server/sync";
import { createMockSupabase } from "../helpers";

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

  it("rejects books array exceeding 50 entries", () => {
    const books = Array.from({ length: 51 }, (_, i) => ({
      bookHash: i.toString(16).padStart(8, "0"),
      highlights: [],
    }));
    const result = validateSyncPayload({ lastSyncedAt: 0, books });
    expect(result).toEqual({ error: expect.stringContaining("50") });
  });

  it("rejects a single book exceeding 500 highlights", () => {
    const highlights = Array.from({ length: 501 }, (_, i) => ({
      chapter: 0,
      startWord: i * 2,
      endWord: i * 2 + 1,
      text: "x",
    }));
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [{ bookHash: "abcd1234", highlights }],
    });
    expect(result).toEqual({ error: expect.stringContaining("500") });
  });

  it("rejects book title exceeding 1000 characters", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          title: "x".repeat(1001),
          highlights: [],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("metadata"),
    });
  });

  it("rejects highlight text exceeding 10000 characters", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "x".repeat(10001),
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("10000"),
    });
  });

  it("rejects highlight styles exceeding 2000 characters", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "valid text",
              styles: "R".repeat(2001),
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("styles"),
    });
  });

  it("accepts fields at exactly the length limits", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          title: "x".repeat(1000),
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "x".repeat(10000),
              chapterTitle: "x".repeat(1000),
              styles: "R".repeat(2000),
            },
          ],
        },
      ],
    });
    expect("payload" in result).toBe(true);
  });

  it("rejects duplicate bookHash in books array", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        { bookHash: "abcd1234", highlights: [] },
        { bookHash: "abcd1234", highlights: [] },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("Duplicate bookHash"),
    });
  });

  it("rejects deletedHighlights exceeding 500 entries", () => {
    const deletedHighlights = Array.from({ length: 501 }, (_, i) => ({
      chapter: 0,
      startWord: i * 2,
      endWord: i * 2 + 1,
    }));
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [{ bookHash: "abcd1234", highlights: [], deletedHighlights }],
    });
    expect(result).toEqual({ error: expect.stringContaining("500") });
  });

  it("rejects chapter exceeding smallint max (32767)", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            { chapter: 32768, startWord: 0, endWord: 10, text: "x" },
          ],
        },
      ],
    });
    expect(result).toEqual({ error: expect.stringContaining("32767") });
  });

  it("rejects invalid paragraphBreaks (non-array)", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "x",
              paragraphBreaks: "not-an-array",
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("paragraphBreaks"),
    });
  });

  it("rejects paragraphBreaks with non-integer entries", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "x",
              paragraphBreaks: [1, 2, 3.5],
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("paragraphBreaks"),
    });
  });

  it("rejects paragraphBreaks exceeding 1000 entries", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "x",
              paragraphBreaks: Array.from({ length: 1001 }, (_, i) => i),
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("paragraphBreaks"),
    });
  });

  it("rejects invalid highlight timestamp", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "x",
              timestamp: -1,
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("timestamp"),
    });
  });

  it("rejects highlight chapterTitle exceeding 1000 characters", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "valid",
              chapterTitle: "x".repeat(1001),
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      error: expect.stringContaining("chapterTitle"),
    });
  });

  it("accepts valid paragraphBreaks and timestamp", () => {
    const result = validateSyncPayload({
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "abcd1234",
          highlights: [
            {
              chapter: 0,
              startWord: 0,
              endWord: 10,
              text: "x",
              paragraphBreaks: [3, 7, 12],
              timestamp: 1712345678,
            },
          ],
        },
      ],
    });
    expect("payload" in result).toBe(true);
  });

  it("rejects total highlights exceeding 2000 across books", () => {
    const highlights = Array.from({ length: 500 }, (_, i) => ({
      chapter: 0,
      startWord: i * 2,
      endWord: i * 2 + 1,
      text: "x",
    }));
    const books = Array.from({ length: 5 }, (_, i) => ({
      bookHash: i.toString(16).padStart(8, "0"),
      highlights,
    }));
    const result = validateSyncPayload({ lastSyncedAt: 0, books });
    expect(result).toEqual({ error: expect.stringContaining("2000") });
  });
});

function setupSyncMocks(
  supabase: ReturnType<typeof createMockSupabase>,
  overrides: Record<string, { data: unknown; error: unknown }> = {},
) {
  const defaults: Record<string, { data: unknown; error: unknown }> = {
    "books.upsert": { data: [], error: null },
    "highlights.upsert": { data: null, error: null },
    "highlights.update": { data: null, error: null },
    "notes.select": { data: [], error: null },
    "highlights.select": { data: [], error: null },
    "book_transfers.select": { data: [], error: null },
    "devices.update": { data: null, error: null },
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    supabase._results.set(key, value);
  }
}

describe("processSync", () => {
  it("returns syncedAt and empty arrays for empty payload", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase);

    const result = await processSync(supabase, "dev-1", "user-1", {
      lastSyncedAt: 0,
      books: [],
    });

    expect(result.syncedAt).toBeGreaterThan(0);
    expect(result.notes).toEqual([]);
    expect(result.deletedHighlights).toEqual([]);
    expect(result.pendingTransfers).toEqual([]);
  });

  it("processes a payload with one book and highlights without error", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
      "books.upsert": {
        data: [{ id: "book-uuid-1", book_hash: "da4c5f2e" }],
        error: null,
      },
    });

    const result = await processSync(supabase, "dev-1", "user-1", {
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "da4c5f2e",
          title: "Leviathan Wakes",
          author: "James S.A. Corey",
          highlights: [
            {
              chapter: 3,
              startWord: 1024,
              endWord: 1078,
              text: "The protomolecule spread...",
              chapterTitle: "Chapter 3",
            },
          ],
        },
      ],
    });

    expect(result.syncedAt).toBeGreaterThan(0);
  });

  it("processes multiple books with highlights in a single batch", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
      "books.upsert": {
        data: [
          { id: "book-uuid-1", book_hash: "da4c5f2e" },
          { id: "book-uuid-2", book_hash: "abcd1234" },
          { id: "book-uuid-3", book_hash: "99887766" },
        ],
        error: null,
      },
    });

    const result = await processSync(supabase, "dev-1", "user-1", {
      lastSyncedAt: 0,
      books: [
        {
          bookHash: "da4c5f2e",
          title: "Book One",
          highlights: [
            { chapter: 1, startWord: 0, endWord: 10, text: "First" },
          ],
        },
        {
          bookHash: "abcd1234",
          title: "Book Two",
          highlights: [
            { chapter: 2, startWord: 50, endWord: 80, text: "Second" },
            { chapter: 3, startWord: 100, endWord: 120, text: "Third" },
          ],
        },
        {
          bookHash: "99887766",
          title: "Book Three",
          highlights: [],
          deletedHighlights: [{ chapter: 0, startWord: 5, endWord: 15 }],
        },
      ],
    });

    expect(result.syncedAt).toBeGreaterThan(0);
    expect(result.notes).toEqual([]);
    expect(result.deletedHighlights).toEqual([]);
    expect(result.pendingTransfers).toEqual([]);
  });

  it("transforms notes from DB join format to response format", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
      "notes.select": {
        data: [
          {
            text: "Great passage",
            updated_at: "2026-04-10T12:00:00Z",
            highlights: {
              chapter_index: 3,
              start_word: 100,
              end_word: 150,
              books: { book_hash: "abcd1234" },
            },
          },
        ],
        error: null,
      },
    });

    const result = await processSync(supabase, "dev-1", "user-1", {
      lastSyncedAt: 1000,
      books: [],
    });

    expect(result.notes).toEqual([
      {
        bookHash: "abcd1234",
        chapter: 3,
        startWord: 100,
        endWord: 150,
        note: "Great passage",
        updatedAt: "2026-04-10T12:00:00Z",
      },
    ]);
  });

  it("transforms deleted highlights from DB join format", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
      "highlights.select": {
        data: [
          {
            chapter_index: 5,
            start_word: 200,
            end_word: 250,
            books: { book_hash: "abcd1234" },
          },
        ],
        error: null,
      },
    });

    const result = await processSync(supabase, "dev-1", "user-1", {
      lastSyncedAt: 1000,
      books: [],
    });

    expect(result.deletedHighlights).toEqual([
      {
        bookHash: "abcd1234",
        chapter: 5,
        startWord: 200,
        endWord: 250,
      },
    ]);
  });

  it("transforms pending transfers from DB format", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
      "book_transfers.select": {
        data: [
          {
            id: "transfer-1",
            filename: "The Martian.epub",
            file_size: 1250000,
          },
        ],
        error: null,
      },
    });

    const result = await processSync(supabase, "dev-1", "user-1", {
      lastSyncedAt: 1000,
      books: [],
    });

    expect(result.pendingTransfers).toEqual([
      {
        id: "transfer-1",
        filename: "The Martian.epub",
        fileSize: 1250000,
      },
    ]);
  });

  it("throws on book upsert failure", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
      "books.upsert": {
        data: null,
        error: { message: "constraint violation" },
      },
    });

    await expect(
      processSync(supabase, "dev-1", "user-1", {
        lastSyncedAt: 0,
        books: [
          { bookHash: "abcd1234", highlights: [], deletedHighlights: [] },
        ],
      }),
    ).rejects.toThrow("Failed to upsert books");
  });

  it("throws on highlight upsert failure", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
      "books.upsert": {
        data: [{ id: "book-uuid-1", book_hash: "abcd1234" }],
        error: null,
      },
      "highlights.upsert": {
        data: null,
        error: { message: "constraint violation" },
      },
    });

    await expect(
      processSync(supabase, "dev-1", "user-1", {
        lastSyncedAt: 0,
        books: [
          {
            bookHash: "abcd1234",
            highlights: [
              { chapter: 1, startWord: 0, endWord: 10, text: "Test" },
            ],
          },
        ],
      }),
    ).rejects.toThrow("Failed to upsert highlights");
  });
});
