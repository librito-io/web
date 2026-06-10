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

import { handle, localeSetup } from "../src/hooks.server";
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
    cookies: { get: () => undefined, getAll: () => [], set: vi.fn() },
    locals: {} as Record<string, unknown>,
    route: { id: "/api/test" },
    platform: undefined,
  } as unknown as Parameters<typeof handle>[0]["event"];
}

describe("hooks.server.ts localeSetup", () => {
  function localeEvent({
    cookie,
    acceptLanguage,
  }: {
    cookie?: string;
    acceptLanguage?: string;
  }) {
    return {
      request: new Request("https://example.com/", {
        headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
      }),
      cookies: {
        get: (name: string) => (name === "librito.locale" ? cookie : undefined),
        getAll: () => [],
        set: vi.fn(),
      },
      locals: {} as Record<string, unknown>,
      route: { id: "/" },
      platform: undefined,
    } as unknown as Parameters<typeof localeSetup>[0]["event"];
  }

  const SSR_HTML = '<!doctype html>\n<html lang="en" dir="ltr">\n<head>';

  async function runLocaleSetup(
    event: Parameters<typeof localeSetup>[0]["event"],
  ) {
    let transformed: string | undefined;
    await localeSetup({
      event,
      resolve: async (_e, opts) => {
        transformed = opts?.transformPageChunk?.({
          html: SSR_HTML,
          done: true,
        }) as string | undefined;
        return new Response("ok");
      },
    });
    return transformed;
  }

  it("sets locals.locale from the cookie", async () => {
    const event = localeEvent({ cookie: "ja", acceptLanguage: "de-DE" });
    await runLocaleSetup(event);
    expect(event.locals.locale).toBe("ja");
  });

  it("falls back to Accept-Language when no cookie", async () => {
    const event = localeEvent({ acceptLanguage: "ko-KR,ko;q=0.9" });
    await runLocaleSetup(event);
    expect(event.locals.locale).toBe("ko");
  });

  it("rewrites the html open tag with the resolved lang", async () => {
    const event = localeEvent({ cookie: "ja" });
    const transformed = await runLocaleSetup(event);
    expect(transformed).toContain('<html lang="ja" dir="ltr">');
  });

  it("sets dir=rtl for Arabic", async () => {
    const event = localeEvent({ cookie: "ar" });
    const transformed = await runLocaleSetup(event);
    expect(transformed).toContain('<html lang="ar" dir="rtl">');
  });

  it("leaves the html tag unchanged for English", async () => {
    const event = localeEvent({});
    const transformed = await runLocaleSetup(event);
    expect(transformed).toContain('<html lang="en" dir="ltr">');
    expect(event.locals.locale).toBe("en");
  });
});

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
