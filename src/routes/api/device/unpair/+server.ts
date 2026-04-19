import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { authenticateDevice } from "$lib/server/auth";
import { jsonError, jsonSuccess } from "$lib/server/errors";

// POST /api/device/unpair
//
// Device-initiated unpair: user tapped Unpair in the Cloud submenu on the
// device. The device wipes its local token/key/email first, then calls this
// endpoint as a best-effort notification so the row disappears from the web
// UI. Idempotent — safe to retry, safe to no-op if the token is already
// unknown (device may retry after its local files are already wiped).
export const POST: RequestHandler = async ({ request }) => {
  const supabase = createAdminClient();

  const authResult = await authenticateDevice(request, supabase);
  if ("error" in authResult) {
    // Token already invalid/revoked: nothing to do, treat as success so the
    // device doesn't keep retrying.
    if (
      authResult.error === "invalid_token" ||
      authResult.error === "token_revoked"
    ) {
      return jsonSuccess({ ok: true });
    }
    return jsonError(401, authResult.error, "Authentication required");
  }

  const { device } = authResult;

  const { error } = await supabase
    .from("devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", device.id);

  if (error) {
    return jsonError(500, "server_error", "Failed to unpair device");
  }

  return jsonSuccess({ ok: true });
};
