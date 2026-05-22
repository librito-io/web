import type { LayoutServerLoad } from "./$types";
import { requireUser } from "$lib/server/auth";

// Auth-gating moved to the appAuthGuard hook in hooks.server.ts (issue
// #348) — it runs for every /app/** request (loads, actions, +server.ts
// endpoints) and redirects unauthenticated GETs to /auth/login with
// ?return_to preserved. This loader is now a pass-through that exposes
// session + user to child page loaders via `await parent()`. The hook
// has already populated locals.user / locals.session as non-null by
// the time this runs.
export const load: LayoutServerLoad = async (event) => {
  const user = requireUser(event);
  // session is guaranteed non-null when user is — the hook narrows on
  // both — but App.Locals types it nullable globally because anonymous
  // routes legitimately have null. Assert via the same hook contract.
  const session = event.locals.session;
  if (!session) {
    // Defense-in-depth — should never fire because the hook narrows
    // session alongside user. Loud 500 surfaces a hook regression.
    throw new Error("locals.session missing in /app/** guarded route");
  }
  return { session, user };
};
