import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { pairRequestLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import { requestPairingCode } from "$lib/server/pairing";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { UUID_RE } from "$lib/server/validation";

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  // Rate limit by IP
  const ip = getClientAddress();
  const limited = await enforceRateLimit(
    pairRequestLimiter,
    ip,
    "Too many requests",
  );
  if (limited) return limited;

  let body: { hardwareId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  if (!body.hardwareId || typeof body.hardwareId !== "string") {
    return jsonError(400, "invalid_request", "hardwareId is required");
  }

  if (!UUID_RE.test(body.hardwareId)) {
    return jsonError(
      400,
      "invalid_request",
      "hardwareId must be a valid UUID v4",
    );
  }

  try {
    const supabase = createAdminClient();
    const result = await requestPairingCode(supabase, body.hardwareId);
    return jsonSuccess(result);
  } catch {
    return jsonError(500, "server_error", "Failed to generate pairing code");
  }
};
