import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const GET: RequestHandler = async ({ locals: { safeGetSession } }) => {
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  const supabase = createAdminClient();

  const { data: transfers, error } = await supabase
    .from("book_transfers")
    .select("id, filename, file_size, status, uploaded_at, downloaded_at")
    .eq("user_id", user.id)
    .order("uploaded_at", { ascending: false });

  if (error) {
    return jsonError(500, "server_error", "Failed to fetch transfers");
  }

  return jsonSuccess({
    transfers: (transfers ?? []).map((t) => ({
      id: t.id,
      filename: t.filename,
      fileSize: t.file_size,
      status: t.status,
      uploadedAt: t.uploaded_at,
      downloadedAt: t.downloaded_at,
    })),
  });
};
