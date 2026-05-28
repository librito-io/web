import { describe, it, expect, vi, beforeEach } from "vitest";

const dynPrivate: Record<string, string | undefined> = {
  COVER_STORAGE_BACKEND: "supabase",
};
vi.mock("$env/dynamic/private", () => ({ env: dynPrivate }));
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example.com",
  UPSTASH_REDIS_REST_TOKEN: "tok",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/public", () => ({ env: {} }));

const adminSupabase = { __admin: true };
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => adminSupabase,
}));

const mutexSentinel = { __mutex: true };
vi.mock("$lib/server/catalog/mutex", () => ({
  getCatalogMutex: vi.fn(async () => mutexSentinel),
}));

const verifySpy = vi.fn();
class FakeReceiver {
  constructor(public opts: unknown) {}
  verify(args: unknown) {
    return verifySpy(args);
  }
}
vi.mock("@upstash/qstash", () => ({
  Receiver: FakeReceiver,
  Client: class {},
}));

const dispatchSpy = vi.fn(async () => undefined);
vi.mock("$lib/server/catalog/dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("$lib/server/catalog/dispatch")>();
  return { ...actual, dispatchResolve: dispatchSpy };
});

const { POST } =
  await import("../../src/routes/api/queue/catalog-resolve/+server");

function makeReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://localhost/api/queue/catalog-resolve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

beforeEach(() => {
  verifySpy.mockReset();
  dispatchSpy.mockReset();
  dynPrivate.QSTASH_CURRENT_SIGNING_KEY = "cur";
  dynPrivate.QSTASH_NEXT_SIGNING_KEY = "nxt";
  dynPrivate.QSTASH_CONSUMER_URL =
    "https://qstash-consumer.test/api/queue/catalog-resolve";
});

describe("POST /api/queue/catalog-resolve", () => {
  it("missing signing keys → 500 server_misconfigured", async () => {
    delete dynPrivate.QSTASH_CURRENT_SIGNING_KEY;
    const res = await POST({ request: makeReq("{}") } as any);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "server_misconfigured" });
  });

  it("missing QSTASH_CONSUMER_URL → 500 server_misconfigured", async () => {
    delete dynPrivate.QSTASH_CONSUMER_URL;
    const res = await POST({ request: makeReq("{}") } as any);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "server_misconfigured" });
  });

  it("signature invalid → 401", async () => {
    verifySpy.mockResolvedValueOnce(false);
    const res = await POST({
      request: makeReq("{}", { "upstash-signature": "bad" }),
    } as any);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("Receiver.verify throws → 401 (catch coerces to false)", async () => {
    verifySpy.mockRejectedValueOnce(new Error("boom"));
    const res = await POST({
      request: makeReq("{}", { "upstash-signature": "x" }),
    } as any);
    expect(res.status).toBe(401);
  });

  it("malformed body → 400", async () => {
    verifySpy.mockResolvedValueOnce(true);
    const res = await POST({
      request: makeReq("not json", { "upstash-signature": "ok" }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_payload" });
  });

  it("valid ISBN payload → dispatchResolve called, 200", async () => {
    verifySpy.mockResolvedValueOnce(true);
    const body = JSON.stringify({
      userId: "u",
      item: { kind: "isbn", isbn: "9780000000000" },
    });
    const res = await POST({
      request: makeReq(body, { "upstash-signature": "ok" }),
    } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resolved: true });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const args = dispatchSpy.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      unknown,
    ];
    expect(args[0]).toBe(adminSupabase);
    expect((args[1] as any).mutex).toBe(mutexSentinel);
    expect(args[2]).toBe("u");
    expect(args[3]).toEqual({ kind: "isbn", isbn: "9780000000000" });
  });

  it("valid TA payload → dispatchResolve called, 200", async () => {
    verifySpy.mockResolvedValueOnce(true);
    const body = JSON.stringify({
      userId: "u",
      item: { kind: "ta", title: "T", author: "A" },
    });
    const res = await POST({
      request: makeReq(body, { "upstash-signature": "ok" }),
    } as any);
    expect(res.status).toBe(200);
    expect(
      (
        dispatchSpy.mock.calls[0] as unknown as [
          unknown,
          unknown,
          unknown,
          unknown,
        ]
      )[3],
    ).toEqual({
      kind: "ta",
      title: "T",
      author: "A",
    });
  });

  it("dispatchResolve throws → 503 transient_failure", async () => {
    verifySpy.mockResolvedValueOnce(true);
    dispatchSpy.mockRejectedValueOnce(new Error("supabase down"));
    const body = JSON.stringify({
      userId: "u",
      item: { kind: "isbn", isbn: "9780000000000" },
    });
    const res = await POST({
      request: makeReq(body, { "upstash-signature": "ok" }),
    } as any);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "transient_failure" });
  });

  it('missing upstash-signature header → 401 (signature coerced to "")', async () => {
    verifySpy.mockResolvedValueOnce(false);
    const body = JSON.stringify({
      userId: "u",
      item: { kind: "isbn", isbn: "9780000000000" },
    });
    const res = await POST({ request: makeReq(body) } as any);
    expect(res.status).toBe(401);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    // Receiver.verify still called with empty-string signature (the ?? "" fallback)
    expect(verifySpy.mock.calls[0][0]).toMatchObject({ signature: "" });
  });
});
