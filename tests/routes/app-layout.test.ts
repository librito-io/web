// /app/+layout.server.ts is now a pass-through that exposes
// session + user from event.locals to child page loaders via
// `await parent()`. Auth-gating moved to appAuthGuard
// (tests/unit/app-auth-guard.test.ts) — issue #348. This file's
// role shrinks to one assertion: the layout pulls from locals.

import { describe, it, expect } from "vitest";

const { load } = await import("../../src/routes/app/+layout.server");

type Session = { access_token: string; user: { id: string } };
type User = { id: string };

function buildEvent(
  session: Session | null,
  user: User | null,
): Parameters<typeof load>[0] {
  const url = new URL("https://example.com/app");
  return {
    locals: { session, user },
    url,
    // Required by @sentry/sveltekit's wrapServerLoadWithSentry, which reads
    // event.request.method to populate the http.method span attribute.
    request: new Request(url),
  } as unknown as Parameters<typeof load>[0];
}

describe("layout /app — pass-through after #348", () => {
  it("returns session + user populated by the appAuthGuard hook", async () => {
    const session: Session = {
      access_token: "x",
      user: { id: "u-1" },
    };
    const user: User = { id: "u-1" };
    const result = await load(buildEvent(session, user));
    expect(result).toEqual({ session, user });
  });

  it("throws 500 when locals.user is null (hook regression backstop)", async () => {
    // The hook should never let an unauthenticated request reach the
    // layout — a null user here means the hook is missing or its
    // prefix gate misfired. 500 surfaces the bug; 401 would hide it.
    await expect(load(buildEvent(null, null))).rejects.toMatchObject({
      status: 500,
    });
  });
});
