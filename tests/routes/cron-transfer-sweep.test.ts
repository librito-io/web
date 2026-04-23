// tests/routes/cron-transfer-sweep.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/static/private", () => ({
  CRON_SECRET: "test-secret",
}));

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } =
  await import("../../src/routes/api/cron/transfer-sweep/+server");

function buildEvent(headers: Record<string, string> = {}) {
  return {
    request: new Request("http://x/api/cron/transfer-sweep", {
      method: "POST",
      headers,
    }),
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  supabase._results.clear();
  supabase._storage.clear();
});

describe("POST /api/cron/transfer-sweep", () => {
  it("returns 401 when Authorization header missing", async () => {
    const res = await POST(buildEvent());
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong CRON_SECRET", async () => {
    const res = await POST(buildEvent({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 with zero counts on empty state", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.delete", { data: null, error: null });

    const res = await POST(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sweep.passA).toBe(0);
    expect(body.sweep.passB).toBe(0);
  });

  it("Pass A removes storage objects for expired rows and nulls storage_path", async () => {
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

    const res = await POST(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sweep.passA).toBe(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });
});
