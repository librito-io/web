import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { requireUser } from "$lib/server/auth";

export const load: LayoutServerLoad = async (event) => {
  const user = requireUser(event);
  const { data: prof, error: profErr } = await event.locals.supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (profErr) error(500, "profile lookup failed");
  // 404 not 403 — don't leak route existence to non-admin users.
  if (!prof?.is_admin) error(404);
  return { adminUser: { id: user.id, email: user.email ?? null } };
};
