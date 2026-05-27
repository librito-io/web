import type { PageServerLoad } from "./$types";
import { createAdminClient } from "$lib/server/supabase";

// Strip everything outside an operator-typing whitelist so the `q` string
// can't break `.or()`'s PostgREST filter syntax (which uses `,` and `)`
// as structural separators). Admin surface so the risk surface is bounded,
// but sanitising here keeps the failure mode "search returns nothing"
// rather than "syntax error from postgrest" on a stray paste.
function sanitizeQuery(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9\s\-'.:]/g, "").trim();
}

export const load: PageServerLoad = async ({ url }) => {
  const rawQ = url.searchParams.get("q") ?? "";
  const q = sanitizeQuery(rawQ);
  if (!q) return { q, results: [] };

  const admin = createAdminClient();
  // Exact prefix on isbn OR title. ts_vector / fuzzy search deferred per
  // spec "Open questions" — exact prefix sufficient for v1.
  const { data, error } = await admin
    .from("book_catalog")
    .select("id, isbn, title, author, storage_path, description")
    .or(`isbn.ilike.${q}%,title.ilike.${q}%`)
    .order("last_attempted_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) throw error;
  return { q, results: data ?? [] };
};
