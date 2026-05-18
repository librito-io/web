import { describe, it, expect } from "vitest";
import {
  scrubEvent,
  REDACTED_FIELDS,
  type ScrubableEvent,
} from "$lib/server/sentry-scrub";

function makeEvent(overrides: Partial<ScrubableEvent> = {}): ScrubableEvent {
  return {
    event_id: "evt-1",
    timestamp: 0,
    ...overrides,
  };
}

describe("scrubEvent", () => {
  it("exposes the canonical redact-field list", () => {
    // Sanity check: the constant is exported and matches pino's list so
    // tests and runtime use the same source of truth.
    expect(REDACTED_FIELDS).toContain("token");
    expect(REDACTED_FIELDS).toContain("api_token_hash");
    expect(REDACTED_FIELDS).toContain("password");
    expect(REDACTED_FIELDS).toContain("email");
    expect(REDACTED_FIELDS).toContain("privateKey");
    expect(REDACTED_FIELDS).toContain("jwk");
  });

  it("strips authorization and cookie headers entirely", () => {
    const event = makeEvent({
      request: {
        headers: {
          authorization: "Bearer sk_device_secret",
          cookie: "sb-access-token=xxx",
          "x-vercel-id": "iad1::abcd",
        },
      },
    });
    const out = scrubEvent(event)!;
    expect(out.request?.headers).not.toHaveProperty("authorization");
    expect(out.request?.headers).not.toHaveProperty("cookie");
    expect(out.request?.headers?.["x-vercel-id"]).toBe("iad1::abcd");
  });

  it("redacts token field values in request.data at top level", () => {
    const event = makeEvent({
      request: { data: { token: "sk_device_xxx", route: "/api/sync" } },
    });
    const out = scrubEvent(event)!;
    expect((out.request?.data as Record<string, unknown>).token).toBe(
      "[REDACTED]",
    );
    expect((out.request?.data as Record<string, unknown>).route).toBe(
      "/api/sync",
    );
  });

  it("redacts nested token / email / api_token_hash / password / privateKey / jwk", () => {
    const event = makeEvent({
      request: {
        data: {
          user: {
            email: "u@example.com",
            api_token_hash: "deadbeef",
            password: "hunter2",
          },
          crypto: { privateKey: "PEM..." },
          auth: { jwk: { kty: "EC", d: "secret" } },
          deep: { nested: { token: "should-also-redact" } },
        },
      },
    });
    const out = scrubEvent(event)!;
    const data = out.request?.data as Record<string, Record<string, unknown>>;
    expect(data.user.email).toBe("[REDACTED]");
    expect(data.user.api_token_hash).toBe("[REDACTED]");
    expect(data.user.password).toBe("[REDACTED]");
    expect(data.crypto.privateKey).toBe("[REDACTED]");
    expect(data.auth.jwk).toBe("[REDACTED]");
    expect((data.deep.nested as Record<string, unknown>).token).toBe(
      "[REDACTED]",
    );
  });

  it("redacts inside event.contexts and event.extra", () => {
    const event = makeEvent({
      contexts: {
        app: { build: "abc", token: "leak1" },
      },
      extra: { user_email: "u@x.com", email: "leak2", note: "ok" },
    });
    const out = scrubEvent(event)!;
    expect((out.contexts?.app as Record<string, unknown>).token).toBe(
      "[REDACTED]",
    );
    expect((out.extra as Record<string, unknown>).email).toBe("[REDACTED]");
    expect((out.extra as Record<string, unknown>).note).toBe("ok");
    // user_email is not on the redact list (substring match would over-scrub);
    // only exact field-name matches redact.
    expect((out.extra as Record<string, unknown>).user_email).toBe("u@x.com");
  });

  it("handles arrays of objects in request.data", () => {
    const event = makeEvent({
      request: {
        data: {
          users: [
            { id: "1", email: "a@x.com" },
            { id: "2", email: "b@x.com" },
          ],
        },
      },
    });
    const out = scrubEvent(event)!;
    const users = (out.request?.data as Record<string, unknown>).users as Array<
      Record<string, unknown>
    >;
    expect(users[0].email).toBe("[REDACTED]");
    expect(users[1].email).toBe("[REDACTED]");
    expect(users[0].id).toBe("1");
  });

  it("does not crash on null / undefined / primitive values", () => {
    const event = makeEvent({
      request: { data: { a: null, b: undefined, c: 42, d: "string" } },
    });
    expect(() => scrubEvent(event)).not.toThrow();
    const out = scrubEvent(event)!;
    const data = out.request?.data as Record<string, unknown>;
    expect(data.a).toBeNull();
    expect(data.c).toBe(42);
    expect(data.d).toBe("string");
  });

  it("does not crash when request is absent", () => {
    const event = makeEvent({});
    expect(() => scrubEvent(event)).not.toThrow();
  });

  it("returns the event (never null) so Sentry always sends after scrub", () => {
    const event = makeEvent({});
    expect(scrubEvent(event)).not.toBeNull();
  });
});
