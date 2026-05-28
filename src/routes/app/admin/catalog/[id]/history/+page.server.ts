import type { PageServerLoad } from "./$types";
import { requireUuidParam } from "$lib/server/auth";
import { createAdminClient } from "$lib/server/supabase";

export const load: PageServerLoad = async ({ params }) => {
  const id = requireUuidParam(params.id);
  // Service-role read so the page shows ALL audit rows for the catalog
  // entry, not only the current admin's. RLS on catalog_admin_actions
  // is self-scoped (admins read own rows), which is correct for the
  // "show audit by admin" cross-cut but would hide history of other
  // operators on this specific row. PR5 has one operator; multi-admin
  // visibility tracked separately under the spec's deferred follow-ups.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("catalog_admin_actions")
    .select("*")
    .eq("catalog_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return { rows: data ?? [], catalogId: id };
};
