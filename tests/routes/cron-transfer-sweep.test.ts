// tests/routes/cron-transfer-sweep.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/dynamic/private", () => ({
  env: { CRON_SECRET: "test-secret" },
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { GET } =
  await import("../../src/routes/api/cron/transfer-sweep/+server");

function buildEvent(headers: Record<string, string> = {}) {
  return {
    request: new Request("http://x/api/cron/transfer-sweep", {
      method: "GET",
      headers,
    }),
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  supabase._results.clear();
  supabase._storage.clear();
});

describe("GET /api/cron/transfer-sweep", () => {
  it("returns 401 when Authorization header missing", async () => {
    const res = await GET(buildEvent());
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong CRON_SECRET", async () => {
    const res = await GET(buildEvent({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 with zero counts on empty state", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.delete", { data: null, error: null });

    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sweep.passA).toBe(0);
    expect(body.sweep.passB).toBe(0);
  });

  it("Pass A removes storage objects for retired rows (expired + downloaded) and nulls storage_path", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        { id: "t1", storage_path: "u/t1/a.epub" },
        { id: "t2", storage_path: "u/t2/b.epub" },
      ],
      error: null,
    });
    supabase._results.set("book_transfers.update", { data: null, error: null });
    supabase._results.set("book_transfers.delete", { data: null, error: null });

    const removeSpy = vi.fn(async () => ({ data: null, error: null }));
    supabase.storage.from = () =>
      ({
        remove: removeSpy,
      }) as unknown as ReturnType<(typeof supabase.storage)["from"]>;

    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sweep.passA).toBe(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });

  // Pass A's UPDATE must re-apply the status filter to close the SELECT→UPDATE
  // TOCTOU window. Without it, a row that left a retired status between
  // SELECT and UPDATE would have storage_path nulled on a live row.
  it("Pass A UPDATE filters status IN (expired, downloaded) to close TOCTOU window", async () => {
    supabase._results.set("book_transfers.select", {
      data: [{ id: "t1", storage_path: "u/t1/a.epub" }],
      error: null,
    });
    supabase._results.set("book_transfers.update", { data: null, error: null });
    supabase._results.set("book_transfers.delete", { data: null, error: null });

    supabase.storage.from = () =>
      ({
        remove: vi.fn(async () => ({ data: null, error: null })),
      }) as unknown as ReturnType<(typeof supabase.storage)["from"]>;

    await GET(buildEvent({ Authorization: "Bearer test-secret" }));

    const updateChainCalls = supabase._chainCalls.filter(
      (c) => c.table === "book_transfers" && c.operation === "update",
    );
    const statusFilter = updateChainCalls.find(
      (c) =>
        c.method === "in" &&
        c.args[0] === "status" &&
        Array.isArray(c.args[1]) &&
        (c.args[1] as string[]).includes("expired") &&
        (c.args[1] as string[]).includes("downloaded"),
    );
    expect(statusFilter).toBeDefined();
  });
});
