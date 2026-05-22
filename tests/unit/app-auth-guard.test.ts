// appAuthGuard is the single auth-check site for /app/** routes.
// Replaces per-loader / per-action / per-endpoint `safeGetSession` +
// 401 blocks (issues #347, #348). Tests cover:
//   - non-/app routes pass through untouched (no DB hit, no session check)
//   - signed-out GET → 303 → /auth/login with ?return_to preserved
//   - signed-out non-GET → 401 JSON (so client JS can show toast)
//   - signed-in → populates locals.user + locals.session, calls resolve
//   - safeGetSession's null-user invariant is honored even if session
//     non-null leaks (defense-in-depth against the regression class
//     this PR architecturally rules out)
//
// Sentry: do NOT import the full hooks.server.ts handle chain — that
// pulls $env/static/public + sentryHandle wiring. Test the exported
// guard in isolation.

import { describe, it, expect, vi } from "vitest";

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://mock.supabase.example",
  PUBLIC_SUPABASE_ANON_KEY: "mock-anon-key",
}));
vi.mock("@sveltejs/kit/hooks", () => ({
  // Bypass sequence so we can import appAuthGuard without the full chain.
  sequence: (...handlers: unknown[]) => handlers,
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({})),
}));

const { appAuthGuard } = await import("../../src/hooks.server");

type Session = { access_token: string; user: { id: string } };
type User = { id: string };

function makeEvent(opts: {
  routeId: string | null;
  method?: string;
  path?: string;
  search?: string;
  session?: Session | null;
  user?: User | null;
}) {
  const path = opts.path ?? "/app";
  const search = opts.search ?? "";
  const locals: Record<string, unknown> = {
    safeGetSession: async () => ({
      session: opts.session ?? null,
      user: opts.user ?? null,
    }),
    session: null,
    user: null,
  };
  return {
    url: new URL(`https://example.com${path}${search}`),
    request: new Request(`https://example.com${path}${search}`, {
      method: opts.method ?? "GET",
    }),
    route: { id: opts.routeId },
    locals,
  } as unknown as Parameters<typeof appAuthGuard>[0]["event"];
}

describe("appAuthGuard", () => {
  it("passes through untouched on non-/app routes", async () => {
    const event = makeEvent({
      routeId: "/auth/login",
      method: "GET",
    });
    const resolve = vi.fn(async () => new Response("ok"));
    const res = await appAuthGuard({ event, resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    // Must NOT populate locals on non-/app routes — those routes
    // legitimately have null user.
    expect(event.locals.user).toBeNull();
  });

  it("passes through untouched on /api/* routes (device-Bearer auth lives in handler)", async () => {
    // /api/sync etc. authenticate via Bearer token in their own
    // handlers — the guard's /app prefix must not catch them.
    const event = makeEvent({
      routeId: "/api/sync",
      method: "POST",
      path: "/api/sync",
    });
    const resolve = vi.fn(async () => new Response("ok"));
    await appAuthGuard({ event, resolve });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("signed-out GET on /app/* → 303 with ?return_to preserved", async () => {
    const event = makeEvent({
      routeId: "/app/book/[bookHash]",
      method: "GET",
      path: "/app/book/abc123",
    });
    const resolve = vi.fn();
    await expect(appAuthGuard({ event, resolve })).rejects.toMatchObject({
      status: 303,
      location:
        "/auth/login?return_to=" + encodeURIComponent("/app/book/abc123"),
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("signed-out GET preserves search params in ?return_to", async () => {
    const event = makeEvent({
      routeId: "/app",
      method: "GET",
      path: "/app",
      search: "?sort=recent",
    });
    await expect(
      appAuthGuard({ event, resolve: vi.fn() }),
    ).rejects.toMatchObject({
      location:
        "/auth/login?return_to=" + encodeURIComponent("/app?sort=recent"),
    });
  });

  it("signed-out POST → 401 JSON (no redirect — preserve form state)", async () => {
    const event = makeEvent({
      routeId: "/app/devices",
      method: "POST",
      path: "/app/devices?/rename",
    });
    const resolve = vi.fn();
    const res = await appAuthGuard({ event, resolve });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toMatchObject({ error: "unauthorized" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("signed-in /app/* → populates locals.user + locals.session, calls resolve", async () => {
    const session: Session = {
      access_token: "x",
      user: { id: "u-1" },
    };
    const user: User = { id: "u-1" };
    const event = makeEvent({
      routeId: "/app/devices",
      method: "GET",
      session,
      user,
    });
    const resolve = vi.fn(async () => new Response("ok"));
    await appAuthGuard({ event, resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(event.locals.session).toEqual(session);
    expect(event.locals.user).toEqual(user);
  });

  it("signed-in non-GET /app/* → populates locals and proceeds (not 401)", async () => {
    // Form action POST: hook must let it through so the action handler
    // can read locals.user via requireUser(). Treating non-GET as
    // automatically 401 would block every signed-in form submission.
    const event = makeEvent({
      routeId: "/app/devices",
      method: "POST",
      session: { access_token: "x", user: { id: "u-1" } },
      user: { id: "u-1" },
    });
    const resolve = vi.fn(async () => new Response("ok"));
    const res = await appAuthGuard({ event, resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it("signed-out non-/app POST → pass-through (not 401)", async () => {
    // Anonymous POSTs to /auth/login form action, /api/pair/request,
    // etc. must NOT get the guard's 401 — those endpoints handle their
    // own auth (or are intentionally anonymous).
    const event = makeEvent({
      routeId: "/api/pair/request",
      method: "POST",
      path: "/api/pair/request",
    });
    const resolve = vi.fn(async () => new Response("ok"));
    const res = await appAuthGuard({ event, resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it("treats session-without-user as unauthenticated (defense-in-depth)", async () => {
    // safeGetSession's contract: both null or both real. If a future
    // regression returns session non-null + user null, the guard must
    // still redirect/401 rather than populate a null user.
    const event = makeEvent({
      routeId: "/app",
      method: "GET",
      session: { access_token: "x", user: { id: "u-1" } },
      user: null,
    });
    await expect(
      appAuthGuard({ event, resolve: vi.fn() }),
    ).rejects.toMatchObject({ status: 303 });
  });
});
