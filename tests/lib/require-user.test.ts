// requireUser narrows event.locals.user to non-null. The appAuthGuard
// hook (hooks.server.ts) populates locals.user before any /app/**
// handler runs, so requireUser is the type-narrowing site at each
// call (devices actions, feed endpoint, app layout). A null read
// here means the hook regressed or the helper is being called
// outside the guarded prefix — both are server-side contract
// violations and surface as 500 (Sentry-paged), not 401.

import { describe, it, expect } from "vitest";
import { requireUser } from "../../src/lib/server/auth";

function makeEvent(user: { id: string } | null) {
  return {
    locals: { user },
  } as unknown as Parameters<typeof requireUser>[0];
}

describe("requireUser", () => {
  it("returns the user when locals.user is populated", () => {
    const user = { id: "u-1" };
    expect(requireUser(makeEvent(user))).toBe(user);
  });

  it("throws 500 (not 401) when locals.user is null", () => {
    // Intentional 500: a null read here is a server bug — either the
    // appAuthGuard hook is missing for this route prefix, or the
    // helper is being called from a route the hook does not gate.
    // 401 would hide the regression as a client auth failure.
    try {
      requireUser(makeEvent(null));
      throw new Error("requireUser did not throw");
    } catch (e: unknown) {
      const err = e as { status?: number; body?: { message?: string } };
      expect(err.status).toBe(500);
      expect(err.body?.message).toMatch(/guarded route/);
    }
  });
});
