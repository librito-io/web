import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({
  locals: { safeGetSession },
}) => {
  const { session, user } = await safeGetSession();
  if (!session) redirect(303, "/auth/login");
  return { session, user };
};
