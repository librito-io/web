import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { requestPairingCode } from "$lib/server/pairing";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({ request }) => {
  let body: { hardwareId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  if (!body.hardwareId || typeof body.hardwareId !== "string") {
    return jsonError(400, "invalid_request", "hardwareId is required");
  }

  try {
    const supabase = createAdminClient();
    const result = await requestPairingCode(supabase, body.hardwareId);
    return jsonSuccess(result);
  } catch {
    return jsonError(500, "server_error", "Failed to generate pairing code");
  }
};
