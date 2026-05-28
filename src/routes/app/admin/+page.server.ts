import type { PageServerLoad } from "./$types";
import { createAdminClient } from "$lib/server/supabase";

// Normalise curly quotes (U+2018/2019 single, U+201C/201D double) to their
// straight ASCII equivalents BEFORE the whitelist filter, so a paste from
// any web UI (which renders smart quotes via CSS or stores them directly)
// hits the same stored straight-apostrophe titles instead of being stripped
// to a mismatched non-apostrophe form.
//
// Then strip everything outside an operator-typing whitelist so the `q`
// string can't break `.or()`'s PostgREST filter syntax (`,` and `)` are
// structural separators). Admin surface so the risk surface is bounded,
// but sanitising here keeps the failure mode "search returns nothing"
// rather than "syntax error from postgrest" on a stray paste.
function sanitizeQuery(raw: string): string {
  return raw
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-zA-Z0-9\s\-'.:]/g, "")
    .trim();
}

export const load: PageServerLoad = async ({ url }) => {
  const rawQ = url.searchParams.get("q") ?? "";
  const q = sanitizeQuery(rawQ);
  if (!q) return { q, results: [] };

  const admin = createAdminClient();
  // Substring ilike on isbn OR title OR author. Substring (vs. prefix) so
  // mid-string operator queries like "Handmaid" hit "The Handmaid's Tale".
  // ts_vector / fuzzy search deferred — substring is sufficient for v1 at
  // pre-launch row counts and `q` is already whitelisted so `%` injection
  // is not a concern.
  const { data, error } = await admin
    .from("book_catalog")
    .select("id, isbn, title, author, storage_path, description")
    .or(`isbn.ilike.%${q}%,title.ilike.%${q}%,author.ilike.%${q}%`)
    .order("last_attempted_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) throw error;
  return { q, results: data ?? [] };
};
