// Unit tests for the DLQ-related load + requeue paths in
// src/routes/app/admin/catalog/[id]/+page.server.ts.
//
// Focus areas:
//   - load: ISBN-only, TA-only, ISBN+TA dedup, Supabase error surfacing
//   - requeue action: stamp scoping via dlqArchiveIds, stamp error → fail(500),
//     no stamp when dlqArchiveIds is empty

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

// --- env stubs (required by every server module that transitively imports
// $env/static/private or $env/dynamic/private) ---
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock-upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: { COVER_STORAGE_BACKEND: "supabase" },
}));
vi.mock("$env/dynamic/public", () => ({ env: {} }));

// --- Supabase admin client ---
const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => supabase }));

// --- Auth: requireAdmin returns a stub user; requireUuidParam passes through
// the id as-is so tests don't need real UUIDs ---
const ADMIN_USER = { id: "admin-u-1" };
vi.mock("$lib/server/auth", () => ({
  requireAdmin: vi.fn(async () => ADMIN_USER),
  requireUuidParam: vi.fn((id: string) => id),
}));

// --- catalog/scheduling: stub out the background re-resolve ---
const scheduleSpy = vi.fn(async () => undefined);
vi.mock("$lib/server/catalog/scheduling", () => ({
  scheduleCatalogResolveIfAllowed: scheduleSpy,
}));

// --- wait-until: synchronous spy so tests don't need to await background work ---
const runInBackgroundSpy = vi.fn((fn: () => unknown) => fn());
vi.mock("$lib/server/wait-until", () => ({
  runInBackground: runInBackgroundSpy,
}));

// --- cover-storage: not exercised in these tests but transitively imported ---
vi.mock("$lib/server/cover-storage", () => ({
  uploadCover: vi.fn(),
  deleteCloudflareImage: vi.fn(),
}));

// --- catalog/dimensions: not exercised here ---
vi.mock("$lib/server/catalog/dimensions", () => ({
  decodeImageDimensions: vi.fn(),
}));

const { load, actions } =
  await import("../../src/routes/app/admin/catalog/[id]/+page.server");

// ─── helpers ────────────────────────────────────────────────────────────────

const CATALOG_ID = "11111111-1111-4111-8111-111111111111";

function buildLoadEvent(id = CATALOG_ID) {
  const url = new URL(`https://example.com/app/admin/catalog/${id}`);
  return {
    params: { id },
    request: new Request(url),
    url,
  } as unknown as Parameters<typeof load>[0];
}

function buildActionEvent(
  formEntries: Record<string, string | string[]>,
  id = CATALOG_ID,
) {
  const formData = new FormData();
  for (const [k, v] of Object.entries(formEntries)) {
    if (Array.isArray(v)) {
      for (const val of v) formData.append(k, val);
    } else {
      formData.append(k, v);
    }
  }
  return {
    params: { id },
    request: new Request(`https://example.com/app/admin/catalog/${id}`, {
      method: "POST",
      body: formData,
    }),
    locals: { user: ADMIN_USER },
  } as unknown as Parameters<typeof actions.requeue>[0];
}

// A minimal book_catalog row sufficient for the DLQ load paths.
function makeCatalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CATALOG_ID,
    isbn: null,
    title: null,
    author: null,
    normalized_title_author: null,
    ...overrides,
  };
}

function makeDlqRow(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    message_id: `msg-${id}`,
    first_failed_at: "2026-01-01T00:00:00.000Z",
    fail_reason: "exhausted",
    archived_at: "2026-01-02T00:00:00.000Z",
    manually_requeued_at: null,
    payload: { userId: "u", item: { kind: "isbn", isbn: "9780000000000" } },
    ...extra,
  };
}

beforeEach(() => {
  supabase._results.clear();
  supabase._resultsQueue.clear();
  supabase._chainCalls.length = 0;
  supabase._updateCalls.length = 0;
  scheduleSpy.mockReset();
  runInBackgroundSpy.mockReset();
  runInBackgroundSpy.mockImplementation((fn: () => unknown) => fn());
});

// Helper to call load and narrow the return type. The SvelteKit-generated
// PageServerLoad return type is `void | PageData` which makes the inferred
// type too wide for tests. Cast via unknown to avoid the `void` branch.
async function callLoad(
  event: Parameters<typeof load>[0],
): Promise<{ row: unknown; dlqArchive: Array<{ id: number }> }> {
  return (await load(event)) as unknown as {
    row: unknown;
    dlqArchive: Array<{ id: number }>;
  };
}

// ─── load: ISBN-only path ────────────────────────────────────────────────────

describe("load /app/admin/catalog/[id] — ISBN-only path", () => {
  it("returns matching DLQ rows ordered desc when row has isbn", async () => {
    const row = makeCatalogRow({ isbn: "9780000000000" });
    supabase._results.set("book_catalog.select", { data: row, error: null });

    const dlqRows = [makeDlqRow(2), makeDlqRow(1)];
    supabase._results.set("catalog_dlq_archive.select", {
      data: dlqRows,
      error: null,
    });

    const result = await callLoad(buildLoadEvent());
    expect(result.dlqArchive).toHaveLength(2);
    expect(result.dlqArchive[0].id).toBe(2);
    expect(result.dlqArchive[1].id).toBe(1);

    // Must have queried via filter on isbn
    const isbnFilter = supabase._chainCalls.find(
      (c) =>
        c.table === "catalog_dlq_archive" &&
        c.method === "filter" &&
        Array.isArray(c.args) &&
        c.args[0] === "payload->item->>isbn",
    );
    expect(isbnFilter).toBeDefined();
  });
});

// ─── load: TA-only path ──────────────────────────────────────────────────────

describe("load /app/admin/catalog/[id] — TA-only path", () => {
  it("returns matching DLQ rows when row has title+author but no isbn", async () => {
    const row = makeCatalogRow({ title: "My Book", author: "My Author" });
    supabase._results.set("book_catalog.select", { data: row, error: null });

    const dlqRows = [makeDlqRow(5)];
    supabase._results.set("catalog_dlq_archive.select", {
      data: dlqRows,
      error: null,
    });

    const result = await callLoad(buildLoadEvent());
    expect(result.dlqArchive).toHaveLength(1);
    expect(result.dlqArchive[0].id).toBe(5);

    // Must have filtered by title and author
    const titleFilter = supabase._chainCalls.find(
      (c) =>
        c.table === "catalog_dlq_archive" &&
        c.method === "filter" &&
        Array.isArray(c.args) &&
        c.args[0] === "payload->item->>title",
    );
    expect(titleFilter).toBeDefined();
  });
});

// ─── load: ISBN + TA → dedup by id ──────────────────────────────────────────

describe("load /app/admin/catalog/[id] — ISBN + TA paths deduped", () => {
  it("deduplicates a DLQ row that matches both ISBN and TA queries", async () => {
    const row = makeCatalogRow({
      isbn: "9780000000000",
      title: "My Book",
      author: "My Author",
    });
    supabase._results.set("book_catalog.select", { data: row, error: null });

    // Both branches return the same row (id=10). ISBN branch also adds id=11.
    const sharedRow = makeDlqRow(10);
    const isbnOnlyRow = makeDlqRow(11);
    supabase._resultsQueue.set("catalog_dlq_archive.select", [
      { data: [sharedRow, isbnOnlyRow], error: null }, // ISBN branch
      { data: [sharedRow], error: null }, // TA branch
    ]);

    const result = await callLoad(buildLoadEvent());
    // id=10 must appear exactly once; id=11 once
    const ids = result.dlqArchive.map((r: { id: number }) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids.filter((id: number) => id === 10)).toHaveLength(1);
    expect(ids.filter((id: number) => id === 11)).toHaveLength(1);
  });
});

// ─── load: Supabase error on one branch → logged, other branch still returned

describe("load /app/admin/catalog/[id] — Supabase error handling", () => {
  it("logs error from one branch but still returns data from the other", async () => {
    const row = makeCatalogRow({
      isbn: "9780000000000",
      title: "My Book",
      author: "My Author",
    });
    supabase._results.set("book_catalog.select", { data: row, error: null });

    // ISBN branch errors; TA branch succeeds
    supabase._resultsQueue.set("catalog_dlq_archive.select", [
      { data: null, error: new Error("db timeout") }, // ISBN branch error
      { data: [makeDlqRow(7)], error: null }, // TA branch succeeds
    ]);

    // Should not throw — error is logged but load completes
    const result = await callLoad(buildLoadEvent());
    // TA branch data is returned
    expect(result.dlqArchive).toHaveLength(1);
    expect(result.dlqArchive[0].id).toBe(7);
  });
});

// ─── requeue action: stamps only dlqArchiveIds from FormData ─────────────────

describe("requeue action — stamp scoping", () => {
  it("scopes UPDATE to the dlqArchiveIds passed via hidden inputs", async () => {
    // book_catalog re-fetch for work derivation
    supabase._results.set("book_catalog.select", {
      data: {
        isbn: "9780000000000",
        title: "T",
        author: "A",
        normalized_title_author: "t a",
      },
      error: null,
    });
    supabase._results.set("rpc.admin_apply_action", {
      data: null,
      error: null,
    });
    supabase._results.set("catalog_dlq_archive.update", {
      data: null,
      error: null,
    });

    const result = await actions.requeue(
      buildActionEvent({
        field_cover: "on",
        dlq_archive_id: ["42", "43"],
      }),
    );

    expect(result).toMatchObject({ ok: true });

    // Must have called UPDATE with .in("id", [42, 43])
    const inFilter = supabase._chainCalls.find(
      (c) =>
        c.table === "catalog_dlq_archive" &&
        c.operation === "update" &&
        c.method === "in" &&
        Array.isArray(c.args) &&
        c.args[0] === "id",
    );
    expect(inFilter).toBeDefined();
    expect(inFilter!.args[1]).toEqual([42, 43]);
  });

  it("threads the TA row's stored normalized_title_author into the scheduled work (#489 Fix A)", async () => {
    // ISBN-less (TA) row whose stored key has drifted from its title/author
    // (the #449 ctx-override froze the key). Requeue must pass the STORED
    // key so the re-resolve updates this row in place instead of forking.
    supabase._results.set("book_catalog.select", {
      data: {
        isbn: null,
        title: "1984 (adaptation)",
        author: "Michael Dean, George Orwell",
        normalized_title_author: "1984|george orwell",
      },
      error: null,
    });
    supabase._results.set("rpc.admin_apply_action", {
      data: null,
      error: null,
    });

    const result = await actions.requeue(
      buildActionEvent({ field_cover: "on" }),
    );
    expect(result).toMatchObject({ ok: true });

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    const [, work] = scheduleSpy.mock.calls[0] as unknown as [
      string,
      unknown[],
      unknown,
    ];
    expect(work).toEqual([
      {
        kind: "ta",
        title: "1984 (adaptation)",
        author: "Michael Dean, George Orwell",
        fields: ["cover"],
        normalizedTitleAuthor: "1984|george orwell",
      },
    ]);
  });

  it("returns fail(500) when stamp UPDATE errors", async () => {
    supabase._results.set("book_catalog.select", {
      data: {
        isbn: "9780000000000",
        title: "T",
        author: "A",
        normalized_title_author: "t a",
      },
      error: null,
    });
    supabase._results.set("rpc.admin_apply_action", {
      data: null,
      error: null,
    });
    supabase._results.set("catalog_dlq_archive.update", {
      data: null,
      error: { message: "update boom" },
    });

    const result = await actions.requeue(
      buildActionEvent({
        field_cover: "on",
        dlq_archive_id: ["42"],
      }),
    );

    expect(result).toMatchObject({ status: 500 });
  });

  it("skips stamp UPDATE entirely when no dlq_archive_id in FormData", async () => {
    supabase._results.set("book_catalog.select", {
      data: {
        isbn: "9780000000000",
        title: "T",
        author: "A",
        normalized_title_author: "t a",
      },
      error: null,
    });
    supabase._results.set("rpc.admin_apply_action", {
      data: null,
      error: null,
    });

    const result = await actions.requeue(
      buildActionEvent({ field_cover: "on" }), // no dlq_archive_id
    );

    expect(result).toMatchObject({ ok: true });

    // No UPDATE on catalog_dlq_archive should have been attempted
    const updateCall = supabase._updateCalls.find(
      (c) => c.table === "catalog_dlq_archive",
    );
    expect(updateCall).toBeUndefined();
  });
});
