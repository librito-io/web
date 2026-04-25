import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
  locals: { safeGetSession, supabase },
}) => {
  const { session } = await safeGetSession();
  if (!session) redirect(303, "/auth/login");

  const { data: transfers } = await supabase
    .from("book_transfers")
    .select(
      "id, filename, file_size, status, uploaded_at, downloaded_at, attempt_count, last_error, last_attempt_at",
    )
    .eq("user_id", session.user.id)
    .is("scrubbed_at", null)
    .order("uploaded_at", { ascending: false });

  return {
    transfers: (transfers ?? []).map((t) => ({
      id: t.id,
      filename: t.filename,
      fileSize: t.file_size,
      status: t.status,
      uploadedAt: t.uploaded_at,
      downloadedAt: t.downloaded_at,
      attemptCount: t.attempt_count,
      lastError: t.last_error,
      lastAttemptAt: t.last_attempt_at,
    })),
  };
};
