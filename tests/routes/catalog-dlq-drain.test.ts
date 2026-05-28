import { describe, it, expect, vi, beforeEach } from "vitest";

const dynPrivate: Record<string, string | undefined> = {};
vi.mock("$env/dynamic/private", () => ({ env: dynPrivate }));
vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://m.example",
  UPSTASH_REDIS_REST_TOKEN: "tok",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/public", () => ({ env: {} }));

import { createMockSupabase } from "../helpers";
const adminSupabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => adminSupabase,
}));

const sentryCaptureMessageSpy = vi.fn();
const sentryCaptureExceptionSpy = vi.fn();
const sentryFlushSpy = vi.fn(async () => true);
vi.mock("@sentry/sveltekit", () => ({
  captureMessage: sentryCaptureMessageSpy,
  captureException: sentryCaptureExceptionSpy,
  flush: sentryFlushSpy,
}));

const listMessagesSpy = vi.fn();
const deleteMessageSpy = vi.fn();
class FakeQstashClient {
  constructor(public opts: unknown) {}
  dlq = {
    listMessages: (...args: unknown[]) => listMessagesSpy(...args),
    delete: (id: string) => deleteMessageSpy(id),
  };
}
vi.mock("@upstash/qstash", () => ({
  Client: FakeQstashClient,
  Receiver: class {},
}));

const { GET } =
  await import("../../src/routes/api/cron/catalog-dlq-drain/+server");

function makeReq(
  authBearer: string | undefined,
  probe = false,
): { request: Request; url: URL } {
  const url = new URL(
    `https://localhost/api/cron/catalog-dlq-drain${probe ? "?probe=1" : ""}`,
  );
  const headers: Record<string, string> = {};
  if (authBearer) headers.authorization = `Bearer ${authBearer}`;
  const request = new Request(url.toString(), { method: "GET", headers });
  return { request, url };
}

beforeEach(() => {
  for (const k of Object.keys(dynPrivate)) delete dynPrivate[k];
  dynPrivate.CRON_SECRET = "secret";
  listMessagesSpy.mockReset();
  deleteMessageSpy.mockReset();
  sentryCaptureMessageSpy.mockReset();
  sentryCaptureExceptionSpy.mockReset();
  sentryFlushSpy.mockReset();
  sentryFlushSpy.mockResolvedValue(true);
  adminSupabase._results.clear();
});

describe("GET /api/cron/catalog-dlq-drain", () => {
  it("missing CRON_SECRET → 500", async () => {
    delete dynPrivate.CRON_SECRET;
    const res = await GET(makeReq("secret") as any);
    expect(res.status).toBe(500);
  });

  it("missing bearer → 401", async () => {
    const res = await GET(makeReq(undefined) as any);
    expect(res.status).toBe(401);
  });

  it("?probe=1 after auth → 200 {probe:true}, no QStash call", async () => {
    const res = await GET(makeReq("secret", true) as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ probe: true });
    expect(listMessagesSpy).not.toHaveBeenCalled();
  });

  it("QSTASH_TOKEN absent → 200 {skipped:true}, no QStash call", async () => {
    const res = await GET(makeReq("secret") as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
    expect(listMessagesSpy).not.toHaveBeenCalled();
  });

  it("DLQ empty → 200 {archived: 0}", async () => {
    dynPrivate.QSTASH_TOKEN = "tok";
    listMessagesSpy.mockResolvedValueOnce({ messages: [] });
    adminSupabase._results.set("catalog_dlq_archive.insert", {
      data: null,
      error: null,
    });
    const res = await GET(makeReq("secret") as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ archived: 0 });
  });

  it("DLQ has 2 messages → INSERT + delete + captureMessage per item", async () => {
    dynPrivate.QSTASH_TOKEN = "tok";
    listMessagesSpy.mockResolvedValueOnce({
      messages: [
        {
          messageId: "msg-1",
          body: JSON.stringify({
            userId: "u",
            item: { kind: "isbn", isbn: "9780000000000" },
          }),
          createdAt: 1700000000000,
          errorDetails: "exhausted",
        },
        {
          messageId: "msg-2",
          body: JSON.stringify({
            userId: "u",
            item: { kind: "ta", title: "T", author: "A" },
          }),
          createdAt: 1700000001000,
          errorDetails: null,
        },
      ],
    });
    adminSupabase._results.set("catalog_dlq_archive.insert", {
      data: null,
      error: null,
    });
    deleteMessageSpy.mockResolvedValue(undefined);
    const res = await GET(makeReq("secret") as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ archived: 2 });
    expect(deleteMessageSpy).toHaveBeenCalledWith("msg-1");
    expect(deleteMessageSpy).toHaveBeenCalledWith("msg-2");
    expect(sentryCaptureMessageSpy).toHaveBeenCalledTimes(2);
  });

  it("INSERT error → no delete, Sentry capture, continue to next message", async () => {
    dynPrivate.QSTASH_TOKEN = "tok";
    listMessagesSpy.mockResolvedValueOnce({
      messages: [
        {
          messageId: "msg-fail",
          body: JSON.stringify({
            userId: "u",
            item: { kind: "isbn", isbn: "9780000000000" },
          }),
          createdAt: 1700000000000,
          errorDetails: "x",
        },
      ],
    });
    adminSupabase._results.set("catalog_dlq_archive.insert", {
      data: null,
      error: { message: "boom" } as any,
    });
    deleteMessageSpy.mockResolvedValue(undefined);
    const res = await GET(makeReq("secret") as any);
    expect(res.status).toBe(200);
    expect(deleteMessageSpy).not.toHaveBeenCalled();
    expect(sentryCaptureExceptionSpy).toHaveBeenCalledTimes(1);
  });

  it("INSERT duplicate (23505) → DOES delete, continues", async () => {
    dynPrivate.QSTASH_TOKEN = "tok";
    listMessagesSpy.mockResolvedValueOnce({
      messages: [
        {
          messageId: "msg-dup",
          body: JSON.stringify({
            userId: "u",
            item: { kind: "isbn", isbn: "9780000000000" },
          }),
          createdAt: 1700000000000,
          errorDetails: "x",
        },
      ],
    });
    adminSupabase._results.set("catalog_dlq_archive.insert", {
      data: null,
      error: { code: "23505", message: "duplicate" } as any,
    });
    deleteMessageSpy.mockResolvedValue(undefined);
    const res = await GET(makeReq("secret") as any);
    expect(res.status).toBe(200);
    expect(deleteMessageSpy).toHaveBeenCalledWith("msg-dup");
  });
});
