import { describe, it, expect } from "vitest";
import { createMockSupabase } from "../helpers";
import {
  validateKoboPayload,
  synthesizeBookHash,
  fnv1a8Hex,
  processKoboImport,
  type KoboImportItem,
} from "$lib/server/import/kobo";
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";

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

  it("accepts a parseable created_at and rejects an unparseable one", () => {
    expect(
      validateKoboPayload([item({ created_at: "2024-01-02T03:04:05Z" })]),
    ).toHaveProperty("items");
    expect(
      validateKoboPayload([item({ created_at: "not-a-date" })]),
    ).toHaveProperty("error");
  });

  it("returns complete=false for a bare array (back-compat)", () => {
    const res = validateKoboPayload([item()]);
    expect("items" in res).toBe(true);
    if ("items" in res) expect(res.complete).toBe(false);
  });

  it("parses complete=true from the { items, complete } object form", () => {
    const res = validateKoboPayload({ items: [item()], complete: true });
    expect("items" in res).toBe(true);
    if ("items" in res) expect(res.complete).toBe(true);
  });

  it("defaults complete=false when the object form omits it", () => {
    const res = validateKoboPayload({ items: [item()] });
    expect("items" in res).toBe(true);
    if ("items" in res) expect(res.complete).toBe(false);
  });

  it("rejects a non-boolean complete", () => {
    const res = validateKoboPayload({ items: [item()], complete: "yes" });
    expect("error" in res).toBe(true);
  });

  it("accepts an empty items array ONLY with complete:true (total-device wipe)", () => {
    const res = validateKoboPayload({ items: [], complete: true });
    expect("items" in res).toBe(true);
    if ("items" in res) {
      expect(res.items).toHaveLength(0);
      expect(res.complete).toBe(true);
    }
  });

  it("rejects a bare empty array (cannot distinguish wipe from a bug)", () => {
    const res = validateKoboPayload([]);
    expect("error" in res).toBe(true);
  });

  it("rejects { items: [] } without complete:true", () => {
    const res = validateKoboPayload({ items: [] });
    expect("error" in res).toBe(true);
  });
});

describe("processKoboImport", () => {
  it("reconciles kobo highlights via the reconcile_kobo_highlights RPC and omits deleted_at", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null }); // no existing rows
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [item()]);

    expect(result.imported).toBe(1);
    expect(result.books).toBe(1);
    expect(result.amended).toBe(0);

    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    expect(rpcCall).toBeDefined();
    const args = rpcCall!.args as {
      p_user_id: string;
      p_rows: Record<string, unknown>[];
      p_amends: unknown[];
    };
    expect(args.p_user_id).toBe("user-1");
    expect(Array.isArray(args.p_amends)).toBe(true);
    const rows = args.p_rows;
    expect(rows[0].source_uid).toBe("bm-1");
    expect(rows[0].book_id).toBe("book-1");
    expect("user_id" in rows[0]).toBe(false);
    expect("deleted_at" in rows[0]).toBe(false);
    expect("start_word" in rows[0]).toBe(false);
    expect("chapter_index" in rows[0]).toBe(false);
  });

  it("synthesizes + upserts a book on the no-ISBN path (ON CONFLICT user_id,book_hash)", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
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
    // Batched ISBN lookup hit — keyed by isbn in the result map.
    mock._results.set("books.select", {
      data: [{ id: "existing-book", isbn: "9780000000001" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [
      item({ isbn: "9780000000001", content_id: "" }),
    ]);

    // No books upsert fired — reused the existing row.
    expect(mock._upsertCalls.find((c) => c.table === "books")).toBeUndefined();
    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    const rows = (rpcCall!.args as { p_rows: Record<string, unknown>[] })
      .p_rows;
    expect(rows[0].book_id).toBe("existing-book");
    expect(result.imported).toBe(1);
  });

  it("synthesizes a book when the ISBN lookup misses (upsert with synthesized hash + isbn)", async () => {
    const mock = createMockSupabase();
    // Batched ISBN lookup returns no rows → miss → synthesize path.
    mock._results.set("books.select", { data: [], error: null });
    mock._results.set("books.upsert", {
      data: [{ id: "new-book", book_hash: "feedface" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [
      item({ isbn: "9780000000099", content_id: "" }),
    ]);

    const bookUpsert = mock._upsertCalls.find((c) => c.table === "books");
    expect(bookUpsert).toBeDefined();
    const row = bookUpsert!.rows as Record<string, unknown>;
    expect(row.isbn).toBe("9780000000099");
    expect(row.book_hash).toMatch(/^[0-9a-f]{8}$/);
    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    const rows = (rpcCall!.args as { p_rows: Record<string, unknown>[] })
      .p_rows;
    expect(rows[0].book_id).toBe("new-book");
    expect(result.imported).toBe(1);
  });

  it("forwards a valid created_at to the RPC and defaults absent to null", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    await processKoboImport(mock, "user-1", [
      item({ source_uid: "ts-1", created_at: "2024-01-02T03:04:05Z" }),
      item({ source_uid: "ts-2", created_at: null }),
    ]);

    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    const rows = (rpcCall!.args as { p_rows: Record<string, unknown>[] })
      .p_rows;
    expect(rows.find((r) => r.source_uid === "ts-1")!.created_at).toBe(
      "2024-01-02T03:04:05Z",
    );
    expect(rows.find((r) => r.source_uid === "ts-2")!.created_at).toBeNull();
  });

  it("groups multiple highlights of the same book under one book resolve", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
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

  it("throws when the batched ISBN lookup errors", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.select", {
      data: null,
      error: { message: "lookup boom" },
    });
    await expect(
      processKoboImport(mock, "user-1", [
        item({ isbn: "9780000000001", content_id: "" }),
      ]),
    ).rejects.toThrow(/Failed to look up books by isbn/);
  });

  it("throws when the reconcile RPC errors", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: null,
      error: { message: "rpc boom" },
    });
    await expect(processKoboImport(mock, "user-1", [item()])).rejects.toThrow(
      /Failed to reconcile highlights/,
    );
  });

  it("throws when the existing-rows SELECT errors", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", {
      data: null,
      error: { message: "select boom" },
    });
    await expect(processKoboImport(mock, "user-1", [item()])).rejects.toThrow(
      /Failed to load existing kobo highlights/,
    );
  });

  it("SELECTs existing rows scoped to source='kobo' for the covered books", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    await processKoboImport(mock, "user-1", [item()]);

    const sourceFilter = mock._chainCalls.find(
      (c) =>
        c.table === "highlights" &&
        c.operation === "select" &&
        c.method === "eq" &&
        c.args[0] === "source" &&
        c.args[1] === "kobo",
    );
    expect(sourceFilter).toBeDefined();
  });

  it("passes the matcher's amends to the RPC and returns the amended count", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    // One absent existing row whose text is contained in the incoming item.
    mock._results.set("highlights.select", {
      data: [
        {
          id: "row-A",
          book_id: "book-1",
          source: "kobo",
          source_uid: "old-uid",
          text: "the quick brown fox jumps over",
          chapter_title: null,
          deleted_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
          removed_from_device_at: null,
        },
      ],
      error: null,
    });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 1, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [
      item({
        source_uid: "new-uid",
        text: "well the quick brown fox jumps over the lazy dog",
      }),
    ]);

    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    const amends = (
      rpcCall!.args as { p_amends: Array<Record<string, unknown>> }
    ).p_amends;
    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({ id: "row-A", source_uid: "new-uid" });
    // imported is the FULL batch size, unchanged by the amend (agent baseline).
    expect(result.imported).toBe(1);
    expect(result.amended).toBe(1);
  });

  it("logs the RPC's cross_book_uid_hits count on the reconcile line", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    // The RPC reports one incoming uid living under another book_id.
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 1 },
      error: null,
    });
    const logs: string[] = [];
    __setTestDestination((line) => logs.push(line));

    await processKoboImport(mock, "user-1", [item({ source_uid: "bm-1" })]);
    __resetTestDestination();

    const line = logs
      .map((l) => JSON.parse(l))
      .find((o) => o.event === "import.kobo.reconcile");
    expect(line).toBeDefined();
    expect(line.crossBookUidHits).toBe(1);
  });

  it("threads p_cutoff and p_complete to the reconcile RPC", async () => {
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    await processKoboImport(mock, "user-1", [item()], true);

    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    const args = rpcCall!.args as { p_cutoff: string; p_complete: boolean };
    expect(args.p_complete).toBe(true);
    expect(typeof args.p_cutoff).toBe("string");
    expect(Number.isNaN(Date.parse(args.p_cutoff))).toBe(false);
  });

  it("routes the stamped column + cutoff into the matcher (beyond-W row → no amend)", async () => {
    // An existing kobo row, absent from incoming, stamped in the ancient past
    // (→ beyond any cutoff), word-matches the fresh item. Without the windowed
    // gate it would amend; with it the matcher excludes the stale row → the RPC
    // receives an EMPTY p_amends. Proves orchestration threads existingRows
    // (incl. removed_from_device_at) + cutoff into computeReconcile.
    const mock = createMockSupabase();
    mock._results.set("books.upsert", {
      data: [{ id: "book-1", book_hash: "deadbeef" }],
      error: null,
    });
    mock._results.set("highlights.select", {
      data: [
        {
          id: "ex-1",
          book_id: "book-1",
          source: "kobo",
          source_uid: "old-uid",
          text: "the quick brown fox jumps over the lazy dog tonight",
          chapter_title: null,
          deleted_at: null,
          created_at: "2020-01-01T00:00:00.000Z",
          removed_from_device_at: "2020-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 0, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    await processKoboImport(
      mock,
      "user-1",
      [
        item({
          source_uid: "new-uid",
          text: "the quick brown fox jumps over the lazy dog tonight extra",
        }),
      ],
      false,
    );

    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    const args = rpcCall!.args as { p_amends: unknown[] };
    expect(args.p_amends).toEqual([]);
  });

  it("empty items + complete:true still calls the RPC (stamp-only wipe, no early-return)", async () => {
    const mock = createMockSupabase();
    mock._results.set("highlights.select", { data: [], error: null });
    mock._results.set("rpc.reconcile_kobo_highlights", {
      data: { amended: 0, stamped: 3, cleared: 0, cross_book_uid_hits: 0 },
      error: null,
    });

    const result = await processKoboImport(mock, "user-1", [], true);

    const rpcCall = mock._rpcCalls.find(
      (c) => c.name === "reconcile_kobo_highlights",
    );
    expect(rpcCall).toBeDefined();
    const args = rpcCall!.args as { p_rows: unknown[]; p_complete: boolean };
    expect(args.p_rows).toEqual([]);
    expect(args.p_complete).toBe(true);
    expect(result.imported).toBe(0);
    expect(result.books).toBe(0);
  });

  it("empty items + complete:false short-circuits without an RPC call", async () => {
    const mock = createMockSupabase();
    const result = await processKoboImport(mock, "user-1", [], false);
    expect(
      mock._rpcCalls.find((c) => c.name === "reconcile_kobo_highlights"),
    ).toBeUndefined();
    expect(result.imported).toBe(0);
  });
});
