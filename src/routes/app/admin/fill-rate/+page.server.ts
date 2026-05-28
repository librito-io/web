import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // RLS policy on catalog_fill_rate_history admits authenticated callers
  // with profiles.is_admin = true. Layout already gated, so the admin
  // is_admin check is implied; the RLS double-gate guards against route
  // misuse if someone bypasses the layout (e.g., direct +server.ts).
  const { data, error } = await locals.supabase
    .from("catalog_fill_rate_history")
    .select("*")
    .order("snapshot_at", { ascending: false })
    .limit(12);
  if (error) throw error;
  return { history: (data ?? []).reverse() };
};
