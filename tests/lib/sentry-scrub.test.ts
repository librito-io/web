import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  scrubEvent,
  REDACTED_FIELDS,
  type ScrubableEvent,
} from "$lib/sentry-scrub";

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
    expect(REDACTED_FIELDS).toContain("userEmail");
    expect(REDACTED_FIELDS).toContain("privateKey");
    expect(REDACTED_FIELDS).toContain("jwk");
    expect(REDACTED_FIELDS).toHaveLength(7);
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
      extra: {
        user_email: "u@x.com",
        email: "leak2",
        userEmail: "leak3",
        note: "ok",
      },
    });
    const out = scrubEvent(event)!;
    expect((out.contexts?.app as Record<string, unknown>).token).toBe(
      "[REDACTED]",
    );
    expect((out.extra as Record<string, unknown>).email).toBe("[REDACTED]");
    // userEmail (camelCase) is on the redact list — matches StatusResult
    // shape returned by checkPairingStatus.
    expect((out.extra as Record<string, unknown>).userEmail).toBe("[REDACTED]");
    expect((out.extra as Record<string, unknown>).note).toBe("ok");
    // user_email (snake_case DB column) is NOT on the redact list; only
    // exact field-name matches redact. Documents the intentional asymmetry.
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

  it("redacts request.query_string when present", () => {
    const event = makeEvent({
      request: { query_string: { token: "qs-token", page: "1" } },
    });
    const out = scrubEvent(event)!;
    const qs = out.request?.query_string as Record<string, unknown>;
    expect(qs.token).toBe("[REDACTED]");
    expect(qs.page).toBe("1");
  });

  it("redacts event.tags when present", () => {
    const event = makeEvent({
      tags: { email: "u@x.com", route: "/api/sync", wait_until: true },
    });
    const out = scrubEvent(event)!;
    const tags = out.tags as Record<string, unknown>;
    expect(tags.email).toBe("[REDACTED]");
    expect(tags.route).toBe("/api/sync");
    expect(tags.wait_until).toBe(true);
  });

  it("query_string handles primitive values (string)", () => {
    const event = makeEvent({
      request: { query_string: "raw=string" },
    });
    expect(() => scrubEvent(event)).not.toThrow();
  });

  it("every REDACTED_FIELDS entry appears in pino's redact list (sync guard)", () => {
    const logSrc = readFileSync(
      new URL("../../src/lib/server/log.ts", import.meta.url),
      "utf8",
    );
    for (const field of REDACTED_FIELDS) {
      // Pino lists redact paths as either `"field"` or `"*.field"`. Either
      // form satisfies the sync requirement. If a future contributor adds
      // a field to REDACTED_FIELDS without adding it to pino, this fails.
      const hasTopLevel = logSrc.includes(`"${field}"`);
      const hasNested = logSrc.includes(`"*.${field}"`);
      expect(
        hasTopLevel || hasNested,
        `${field} missing from pino redact paths in log.ts`,
      ).toBe(true);
    }
  });
});
