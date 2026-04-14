import type { PageServerLoad } from "./$types";

type LibraryRow = {
  id: string;
  book_hash: string;
  title: string | null;
  author: string | null;
  language: string | null;
  isbn: string | null;
  updated_at: string;
  highlight_count: number;
  last_activity: string | null;
};

export const load: PageServerLoad = async ({
  locals: { supabase, safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return { books: [] as LibraryRow[] };

  const { data, error } = await supabase.rpc("get_library");
  if (error) {
    console.error("get_library failed", error);
    return { books: [] as LibraryRow[] };
  }

  const rows = (data ?? []) as LibraryRow[];
  return {
    books: rows.map((b) => ({
      ...b,
      highlight_count: Number(b.highlight_count),
    })),
  };
};
