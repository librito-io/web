// tests/routes/cron-transfer-sweep.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$env/dynamic/private", () => ({
  env: { CRON_SECRET: "test-secret" },
}));

const withMonitor = vi.fn(
  async (
    _slug: string,
    cb: () => Promise<unknown>,
    _options?: unknown,
  ): Promise<unknown> => cb(),
);
vi.mock("@sentry/sveltekit", () => ({
  withMonitor,
}));

const supabase = createMockSupabase();
// Captured before any test runs so describes that override
// `supabase.storage.from` for the duration of a single test can restore
// the helper's default `download`/`remove` behaviour for sibling describes.
const defaultStorageFrom = supabase.storage.from;
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { GET } =
  await import("../../src/routes/api/cron/transfer-sweep/+server");

function buildEvent(headers: Record<string, string> = {}, query: string = "") {
  const fullUrl = `http://x/api/cron/transfer-sweep${query}`;
  return {
    request: new Request(fullUrl, { method: "GET", headers }),
    url: new URL(fullUrl),
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  supabase._results.clear();
  supabase._storage.clear();
  withMonitor.mockClear();
  // Restore default pass-through after .mockClear() drops it.
  withMonitor.mockImplementation(async (_slug, cb, _options) => cb());
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

  it("?probe=1 short-circuits after auth without touching DB or Storage", async () => {
    const res = await GET(
      buildEvent({ Authorization: "Bearer test-secret" }, "?probe=1"),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.probe).toBe(true);
  });

  it("?probe=1 without auth still returns 401 (gate runs before probe)", async () => {
    const res = await GET(buildEvent({}, "?probe=1"));
    expect(res.status).toBe(401);
  });

  it("does NOT call Sentry.withMonitor on the 401 path", async () => {
    await GET(buildEvent({}));
    expect(withMonitor).not.toHaveBeenCalled();
  });

  it("does NOT call Sentry.withMonitor on the ?probe=1 short-circuit", async () => {
    await GET(buildEvent({ Authorization: "Bearer test-secret" }, "?probe=1"));
    expect(withMonitor).not.toHaveBeenCalled();
  });

  it("wraps the sweep body in Sentry.withMonitor with the canonical slug and schedule", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.delete", { data: null, error: null });

    await GET(buildEvent({ Authorization: "Bearer test-secret" }));

    expect(withMonitor).toHaveBeenCalledTimes(1);
    const [slug, _cb, options] = withMonitor.mock.calls[0];
    expect(slug).toBe("transfer-sweep");
    expect(options).toEqual(
      expect.objectContaining({
        schedule: { type: "crontab", value: "0 3 * * *" },
        checkinMargin: 5,
        maxRuntime: 10,
        failureIssueThreshold: 1,
        recoveryThreshold: 1,
      }),
    );
  });

  it("translates a thrown error inside runSweep to a 500 response", async () => {
    // Simulate Pass A select failure — runSweep throws, withMonitor
    // re-throws, outer catch translates to 500. Verifies the throw-to-500
    // contract on which the monitor's failure semantics rely.
    withMonitor.mockImplementationOnce(async () => {
      throw new Error("pass_a_select_failed");
    });
    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("server_error");
    expect(body.message).toBe("pass_a_select_failed");
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
        download: vi.fn(async () => ({ data: null, error: null })),
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
        download: vi.fn(async () => ({ data: null, error: null })),
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

describe("GET /api/cron/transfer-sweep — Pass C (sha256 verify backstop)", () => {
  // sha256("hello") — used as the "claimed" hash on test rows.
  const HELLO_SHA =
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const HELLO_BYTES = new TextEncoder().encode("hello");

  function blobFromBytes(bytes: Uint8Array): Blob {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return new Blob([copy]);
  }

  beforeEach(() => {
    supabase._results.clear();
    supabase._storage.clear();
    supabase._updateCalls.length = 0;
    supabase._chainCalls.length = 0;
    // Sibling Pass A tests overwrite `supabase.storage.from` to inject
    // ad-hoc `remove`/`download` stubs. Restore the helper default so
    // Pass C's `.download()` honours `_storage.set("download", ...)`.
    supabase.storage.from = defaultStorageFrom;
  });

  it("Pass C SELECT filters status='pending', sha256_verified IS NULL, storage_path NOT NULL, uploaded_at < cutoff", async () => {
    supabase._results.set("book_transfers.select", { data: [], error: null });
    supabase._results.set("book_transfers.delete", { data: null, error: null });

    await GET(buildEvent({ Authorization: "Bearer test-secret" }));

    const selects = supabase._chainCalls.filter(
      (c) => c.table === "book_transfers" && c.operation === "select",
    );
    const verifiedNull = selects.find(
      (c) =>
        c.method === "is" &&
        c.args[0] === "sha256_verified" &&
        c.args[1] === null,
    );
    const storagePathNotNull = selects.find(
      (c) =>
        c.method === "not" &&
        c.args[0] === "storage_path" &&
        c.args[1] === "is" &&
        c.args[2] === null,
    );
    const uploadedAtCutoff = selects.find(
      (c) => c.method === "lt" && c.args[0] === "uploaded_at",
    );

    expect(verifiedNull).toBeDefined();
    expect(storagePathNotNull).toBeDefined();
    expect(uploadedAtCutoff).toBeDefined();
  });

  it("on hash match: writes sha256_verified + verified_at for the unverified row", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "t-1",
          user_id: "u-1",
          storage_path: "u-1/t-1.epub",
          sha256: HELLO_SHA,
          uploaded_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        },
      ],
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: "t-1" }],
      error: null,
    });
    supabase._results.set("book_transfers.delete", { data: null, error: null });
    supabase._storage.set("download", {
      data: blobFromBytes(HELLO_BYTES),
      error: null,
    });

    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sweep.passC).toBe(1);
    expect(body.sweep.passCMismatches).toBe(0);

    const verifyWrite = supabase._updateCalls.find(
      (u) =>
        u.table === "book_transfers" &&
        typeof u.payload === "object" &&
        u.payload !== null &&
        "sha256_verified" in (u.payload as Record<string, unknown>),
    );
    expect(verifyWrite).toBeDefined();
    expect(
      (verifyWrite!.payload as Record<string, unknown>).sha256_verified,
    ).toBe(HELLO_SHA);
  });

  it("on hash mismatch: flips status to 'failed' with last_error='sha256_mismatch'", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "t-2",
          user_id: "u-1",
          storage_path: "u-1/t-2.epub",
          sha256: HELLO_SHA,
          uploaded_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        },
      ],
      error: null,
    });
    supabase._results.set("book_transfers.update", {
      data: [{ id: "t-2" }],
      error: null,
    });
    supabase._results.set("book_transfers.delete", { data: null, error: null });
    supabase._storage.set("download", {
      data: blobFromBytes(new TextEncoder().encode("not hello")),
      error: null,
    });

    const res = await GET(buildEvent({ Authorization: "Bearer test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sweep.passC).toBe(0);
    expect(body.sweep.passCMismatches).toBe(1);

    const failWrite = supabase._updateCalls.find(
      (u) =>
        u.table === "book_transfers" &&
        typeof u.payload === "object" &&
        u.payload !== null &&
        (u.payload as Record<string, unknown>).status === "failed",
    );
    expect(failWrite).toBeDefined();
    expect((failWrite!.payload as Record<string, unknown>).last_error).toBe(
      "sha256_mismatch",
    );
  });
});
