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
});

function setupSyncMocks(
  supabase: ReturnType<typeof createMockSupabase>,
  overrides: Record<string, { data: unknown; error: unknown }> = {},
) {
  const defaults: Record<string, { data: unknown; error: unknown }> = {
    "books.upsert": { data: { id: "book-uuid-1" }, error: null },
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
    setupSyncMocks(supabase);

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
    ).rejects.toThrow("Failed to upsert book");
  });

  it("throws on highlight upsert failure", async () => {
    const supabase = createMockSupabase();
    setupSyncMocks(supabase, {
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
