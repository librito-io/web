import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";

export type LibraryHighlight = {
  id: string;
  chapter_index: number;
  chapter_title: string | null;
  start_word: number;
  end_word: number;
  text: string;
  styles: string | null;
  paragraph_breaks: number[] | null;
  updated_at: string;
  note_text: string | null;
  note_updated_at: string | null;
};

export type LibraryBook = {
  id: string;
  book_hash: string;
  title: string | null;
  author: string | null;
  language: string | null;
  isbn: string | null;
  last_activity: string | null;
  highlights: LibraryHighlight[];
};

export const load: PageServerLoad = async ({
  locals: { supabase, safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) return { books: [] as LibraryBook[] };

  const { data, error: rpcError } = await supabase.rpc(
    "get_library_with_highlights",
  );
  if (rpcError) {
    console.error("get_library_with_highlights failed", rpcError);
    error(500, "Failed to load library");
  }

  return { books: (data ?? []) as LibraryBook[] };
};
