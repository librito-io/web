import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
  locals: { safeGetSession, supabase },
}) => {
  const { session } = await safeGetSession();
  if (!session) redirect(303, "/auth/login");

  const { data: transfers } = await supabase
    .from("book_transfers")
    .select("id, filename, file_size, status, uploaded_at, downloaded_at")
    .order("uploaded_at", { ascending: false });

  return { transfers: transfers ?? [] };
};
