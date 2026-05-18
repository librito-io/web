import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$env/dynamic/private", () => ({
  env: { CRON_SECRET: "test-secret" },
}));

const captureException = vi.fn();
const flush = vi.fn(async () => true);
vi.mock("@sentry/sveltekit", () => ({
  captureException,
  flush,
}));

const { POST } =
  await import("../../src/routes/api/debug/sentry-smoke/+server");

function buildEvent(
  headers: Record<string, string> = {},
  query: string = "",
  platform?: { context?: { waitUntil?: (p: Promise<unknown>) => void } },
) {
  const url = `http://x/api/debug/sentry-smoke${query}`;
  return {
    request: new Request(url, { method: "POST", headers }),
    url: new URL(url),
    platform,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  captureException.mockClear();
});

describe("POST /api/debug/sentry-smoke", () => {
  it("returns 401 when Authorization header missing", async () => {
    const res = await POST(buildEvent());
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong CRON_SECRET", async () => {
    const res = await POST(buildEvent({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("?probe=1 with valid bearer returns 200 with probe body", async () => {
    const res = await POST(
      buildEvent({ Authorization: "Bearer test-secret" }, "?probe=1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ probe: true });
  });

  it("?probe=1 without bearer returns 401 (auth before probe)", async () => {
    const res = await POST(buildEvent({}, "?probe=1"));
    expect(res.status).toBe(401);
  });

  it("non-probe POST with valid bearer returns 202 with scheduled id", async () => {
    const res = await POST(buildEvent({ Authorization: "Bearer test-secret" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.scheduled).toBe(true);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  });

  it("non-probe POST schedules a throw that flows to Sentry.captureException", async () => {
    await POST(buildEvent({ Authorization: "Bearer test-secret" }));
    // runInBackground starts work synchronously; the throw resolves on
    // the next microtask via the internal .catch in wait-until.ts.
    await new Promise((r) => setTimeout(r, 0));
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^sentry-smoke-test-/);
    expect(ctx).toEqual({ tags: { wait_until: true } });
  });
});

describe("POST /api/debug/sentry-smoke — missing CRON_SECRET", () => {
  it("returns 500 server_misconfigured when env unset", async () => {
    vi.resetModules();
    vi.doMock("$env/dynamic/private", () => ({ env: {} }));
    const mod = await import("../../src/routes/api/debug/sentry-smoke/+server");
    const res = await mod.POST(
      buildEvent({ Authorization: "Bearer anything" }),
    );
    expect(res.status).toBe(500);
    vi.doUnmock("$env/dynamic/private");
  });
});
