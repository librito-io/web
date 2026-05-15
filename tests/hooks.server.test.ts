import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Handle } from "@sveltejs/kit";

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://mock.supabase.example",
  PUBLIC_SUPABASE_ANON_KEY: "mock-anon-key",
}));

// SvelteKit's real sequence() pulls from a per-request store that the
// framework only initializes inside a running server. Bare vitest has no
// such store, so we stub sequence with the equivalent right-to-left
// resolve-chaining: each handler's `resolve` becomes a call to the next
// handler, with the innermost handler's `resolve` being the original.
vi.mock("@sveltejs/kit/hooks", () => ({
  sequence: (...handlers: Handle[]): Handle => {
    return async ({ event, resolve }) => {
      let chain = resolve;
      for (let i = handlers.length - 1; i >= 0; i--) {
        const handler = handlers[i];
        const next = chain;
        chain = (e) => handler({ event: e, resolve: next });
      }
      return chain(event);
    };
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    },
  })),
}));

import { handle } from "../src/hooks.server";
import {
  logger,
  __setTestDestination,
  __resetTestDestination,
} from "../src/lib/server/log";

function fakeEvent(headers: Record<string, string> = {}) {
  return {
    request: new Request("https://example.com/api/test", {
      method: "POST",
      headers,
    }),
    cookies: { getAll: () => [], set: vi.fn() },
    locals: {} as Record<string, unknown>,
    route: { id: "/api/test" },
    platform: undefined,
  } as unknown as Parameters<typeof handle>[0]["event"];
}

describe("hooks.server.ts requestId", () => {
  let writes: Record<string, unknown>[];

  beforeEach(() => {
    writes = [];
    __setTestDestination((line) => writes.push(JSON.parse(line)));
  });

  afterEach(() => __resetTestDestination());

  it("uses x-vercel-id when present", async () => {
    const event = fakeEvent({ "x-vercel-id": "iad1::abc123" });
    const response = await handle({
      event,
      resolve: async () => new Response("ok"),
    });
    expect(event.locals.requestId).toBe("iad1::abc123");
    expect(response.headers.get("x-request-id")).toBe("iad1::abc123");
  });

  it("falls back to crypto.randomUUID when x-vercel-id absent", async () => {
    const event = fakeEvent();
    const response = await handle({
      event,
      resolve: async () => new Response("ok"),
    });
    expect(event.locals.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(response.headers.get("x-request-id")).toBe(event.locals.requestId);
  });

  it("logs emitted from within resolve carry requestId", async () => {
    const event = fakeEvent({ "x-vercel-id": "iad1::xyz" });
    await handle({
      event,
      resolve: async () => {
        logger().info({ event: "inside_resolve" }, "inside_resolve");
        return new Response("ok");
      },
    });
    expect(writes).toContainEqual(
      expect.objectContaining({
        requestId: "iad1::xyz",
        route: "/api/test",
        method: "POST",
        event: "inside_resolve",
      }),
    );
  });
});
