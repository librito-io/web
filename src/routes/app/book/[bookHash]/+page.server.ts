import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

type Highlight = {
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

type Payload = {
  book: {
    id: string;
    book_hash: string;
    title: string | null;
    author: string | null;
    language: string | null;
    isbn: string | null;
    updated_at: string;
  };
  highlights: Highlight[];
};

export const load: PageServerLoad = async ({
  params,
  locals: { supabase, safeGetSession },
}) => {
  const { user } = await safeGetSession();
  if (!user) throw error(401, "Unauthorized");

  const { data, error: rpcErr } = await supabase.rpc(
    "get_book_with_highlights",
    { p_book_hash: params.bookHash },
  );
  if (rpcErr) {
    console.error("get_book_with_highlights failed", rpcErr);
    throw error(500, "Failed to load book");
  }
  if (!data) throw error(404, "Book not found");

  const payload = data as Payload;
  return { book: payload.book, highlights: payload.highlights };
};
