import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({
  locals: { safeGetSession },
}) => {
  const { session, user } = await safeGetSession();
  // Narrow on both so child loaders consuming `await parent()` see
  // `session` and `user` as non-null. Removes 4 redundant
  // `safeGetSession` calls in child page loaders (issue #151). Note:
  // form actions and `+server.ts` API endpoints do NOT run through this
  // guard — they must still authenticate at their own entry points.
  if (!session || !user) redirect(303, "/auth/login");
  return { session, user };
};
