import { describe, it, expect } from "vitest";
import { createMockSupabase } from "../helpers";
import {
  validateKoboPayload,
  synthesizeBookHash,
  fnv1a8Hex,
  processKoboImport,
  type KoboImportItem,
} from "$lib/server/import/kobo";

function item(overrides: Partial<KoboImportItem> = {}): KoboImportItem {
  return {
    source_uid: "bm-1",
    text: "highlighted text",
    title: "The Hobbit",
    author: "J.R.R. Tolkien",
    content_id: "file:///mnt/onboard/hobbit.epub",
    isbn: null,
    chapter_title: null,
    created_at: null,
    ...overrides,
  };
}

describe("fnv1a8Hex / synthesizeBookHash", () => {
  it("produces 8 lowercase hex chars matching the book_hash CHECK", () => {
    expect(fnv1a8Hex("anything")).toMatch(/^[0-9a-f]{8}$/);
    expect(synthesizeBookHash({ contentId: "file:///x.epub" })).toMatch(
      /^[0-9a-f]{8}$/,
    );
    expect(synthesizeBookHash({ isbn: "9780000000001" })).toMatch(
      /^[0-9a-f]{8}$/,
    );
  });

  it("is deterministic for the same input", () => {
    expect(fnv1a8Hex("file:///x.epub")).toBe(fnv1a8Hex("file:///x.epub"));
    expect(synthesizeBookHash({ contentId: "c1" })).toBe(
      synthesizeBookHash({ contentId: "c1" }),
    );
  });

  it("namespaces isbn vs content_id so they do not collide on equal raw value", () => {
    // Same raw string, different namespace → different hash.
    expect(synthesizeBookHash({ isbn: "X" })).not.toBe(
      synthesizeBookHash({ contentId: "X" }),
    );
  });

  it("distinct inputs generally produce distinct hashes", () => {
    expect(fnv1a8Hex("a")).not.toBe(fnv1a8Hex("b"));
  });
});

describe("validateKoboPayload", () => {
  it("accepts a minimal valid item (bare array)", () => {
    const res = validateKoboPayload([item()]);
    expect("items" in res).toBe(true);
    if ("items" in res) {
      expect(res.items).toHaveLength(1);
      expect(res.items[0].source_uid).toBe("bm-1");
    }
  });

  it("accepts a { items: [...] } wrapper", () => {
    const res = validateKoboPayload({ items: [item()] });
    expect("items" in res).toBe(true);
  });

  it("rejects a non-array, non-wrapper body", () => {
    expect(validateKoboPayload({ foo: 1 })).toHaveProperty("error");
    expect(validateKoboPayload("nope")).toHaveProperty("error");
  });

  it("rejects an empty batch", () => {
    expect(validateKoboPayload([])).toHaveProperty("error");
  });

  it("rejects a missing/empty source_uid", () => {
    expect(validateKoboPayload([item({ source_uid: "" })])).toHaveProperty(
      "error",
    );
    expect(
      validateKoboPayload([{ ...item(), source_uid: undefined }]),
    ).toHaveProperty("error");
  });

  it("rejects empty or oversized text", () => {
    expect(validateKoboPayload([item({ text: "" })])).toHaveProperty("error");
    expect(
      validateKoboPayload([item({ text: "x".repeat(10_001) })]),
    ).toHaveProperty("error");
  });

  it("rejects missing title or author (the cover signal)", () => {
    expect(validateKoboPayload([item({ title: "" })])).toHaveProperty("error");
    expect(validateKoboPayload([item({ author: "" })])).toHaveProperty("error");
  });

  it("requires content_id or isbn for book identity", () => {
    const res = validateKoboPayload([item({ content_id: "", isbn: null })]);
    expect(res).toHaveProperty("error");
  });

  it("accepts an isbn-bearing item with no content_id", () => {
    const res = validateKoboPayload([
      item({ content_id: "", isbn: "9780000000001" }),
    ]);
    expect("items" in res).toBe(true);
    if ("items" in res) expect(res.items[0].isbn).toBe("9780000000001");
  });

  it("rejects an oversized batch", () => {
    const many = Array.from({ length: 2001 }, (_, i) =>
      item({ source_uid: `bm-${i}` }),
    );
    expect(validateKoboPayload(many)).toHaveProperty("error");
  });

  it("rejects a duplicate source_uid within the same book", () => {
    const res = validateKoboPayload([item(), item()]); // same source_uid + book
    expect(res).toHaveProperty("error");
  });
});

describe("processKoboImport", () => {
  it("upserts kobo highlights via the upsert_kobo_highlights RPC and omits deleted_at", async () => {
    const mock = createMockSupabase();
    // No-ISBN path: book upsert returns an id.
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [item()]);

    expect(result.imported).toBe(1);
    expect(result.books).toBe(1);

    // Highlights go through the RPC (partial-index upsert; supabase-js
    // .upsert() can't thread the WHERE predicate).
    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "upsert_kobo_highlights",
    );
    expect(rpcCall).toBeDefined();
    const rows = (rpcCall!.args as { p_rows: Record<string, unknown>[] })
      .p_rows;
    expect(rows[0].source_uid).toBe("bm-1");
    expect(rows[0].book_id).toBe("book-1");
    expect(rows[0].user_id).toBe("user-1");
    // Load-bearing: deleted_at must NOT be in the payload (no resurrection).
    expect("deleted_at" in rows[0]).toBe(false);
    // Word fields must NOT be set (Kobo rows are not word-index based).
    // (source='kobo' is forced inside the RPC, not in the JS payload.)
    expect("start_word" in rows[0]).toBe(false);
    expect("chapter_index" in rows[0]).toBe(false);
  });

  it("synthesizes + upserts a book on the no-ISBN path (ON CONFLICT user_id,book_hash)", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });

    await processKoboImport(mock, "user-1", [item({ isbn: null })]);

    const bookUpsert = mock._upsertCalls.find((c) => c.table === "books");
    expect(bookUpsert).toBeDefined();
    expect((bookUpsert!.opts as { onConflict: string }).onConflict).toBe(
      "user_id,book_hash",
    );
    const row = bookUpsert!.rows as Record<string, unknown>;
    expect(row.user_id).toBe("user-1");
    expect(row.title).toBe("The Hobbit");
    expect(row.author).toBe("J.R.R. Tolkien");
    expect(row.book_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("reuses an existing book on an ISBN hit (no books upsert)", async () => {
    const mock = createMockSupabase();
    // ISBN lookup hit.
    mock._results.set("books.select", {
      data: [{ id: "existing-book" }],
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [
      item({ isbn: "9780000000001", content_id: "" }),
    ]);

    // No books upsert fired — reused the existing row.
    expect(mock._upsertCalls.find((c) => c.table === "books")).toBeUndefined();
    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "upsert_kobo_highlights",
    );
    const rows = (rpcCall!.args as { p_rows: Record<string, unknown>[] })
      .p_rows;
    expect(rows[0].book_id).toBe("existing-book");
    expect(result.imported).toBe(1);
  });

  it("groups multiple highlights of the same book under one book resolve", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [
      item({ source_uid: "bm-1" }),
      item({ source_uid: "bm-2" }),
    ]);

    expect(result.books).toBe(1);
    expect(result.imported).toBe(2);
    expect(mock._upsertCalls.filter((c) => c.table === "books")).toHaveLength(
      1,
    );
  });

  it("throws when the book upsert errors (all-or-nothing → 500 at route)", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: null,
      error: { message: "boom" },
    });
    await expect(processKoboImport(mock, "user-1", [item()])).rejects.toThrow(
      /Failed to upsert book/,
    );
  });
});
