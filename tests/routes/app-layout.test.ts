// Layout guard at `src/routes/app/+layout.server.ts` is the single
// auth-check site for every page load under `/app/*` (issue #151).
// Child page loaders consume `await parent()` rather than re-calling
// `safeGetSession`, so this layout is where unauthenticated-redirect
// behavior must be verified. Per-page redirect tests under
// `tests/routes/*-page.test.ts` were removed in the same change.
//
// Scope: page **load** functions only. Form actions and `+server.ts`
// API endpoints do NOT run through this guard — those continue to
// authenticate at their own entry points and are covered by their own
// test files. Follow-up planned to consolidate the remaining sites
// into `hooks.server.ts`.

import { describe, it, expect } from "vitest";

const { load } = await import("../../src/routes/app/+layout.server");

type Session = { access_token: string; user: { id: string } };
type User = { id: string };

function buildEvent(result: {
  session: Session | null;
  user: User | null;
}): Parameters<typeof load>[0] {
  const url = new URL("https://example.com/app");
  return {
    locals: { safeGetSession: async () => result },
    url,
    // Required by @sentry/sveltekit's wrapServerLoadWithSentry, which reads
    // event.request.method to populate the http.method span attribute.
    request: new Request(url),
  } as unknown as Parameters<typeof load>[0];
}

describe("layout guard /app", () => {
  it("redirects to /auth/login when session is missing", async () => {
    await expect(
      load(buildEvent({ session: null, user: null })),
    ).rejects.toMatchObject({ status: 303, location: "/auth/login" });
  });

  it("redirects to /auth/login when user is missing despite session present", async () => {
    // safeGetSession's invariant is paired (both null or both real), but
    // we narrow on both anyway so child loaders consuming `await parent()`
    // see `user` as non-null. A future regression that returned
    // `{ session, user: null }` would otherwise leak past the guard.
    const session: Session = {
      access_token: "x",
      user: { id: "u-1" },
    };
    await expect(
      load(buildEvent({ session, user: null })),
    ).rejects.toMatchObject({ status: 303, location: "/auth/login" });
  });

  it("returns non-null session + user when authenticated", async () => {
    const session: Session = {
      access_token: "x",
      user: { id: "u-1" },
    };
    const user: User = { id: "u-1" };
    const result = await load(buildEvent({ session, user }));
    expect(result).toEqual({ session, user });
  });
});
