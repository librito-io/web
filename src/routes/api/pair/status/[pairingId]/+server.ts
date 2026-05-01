import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import {
  redis,
  pairStatusLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { checkPairingStatus } from "$lib/server/pairing";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const GET: RequestHandler = async ({ params, getClientAddress }) => {
  // Rate limit by IP
  const ip = getClientAddress();
  const limited = await enforceRateLimit(
    pairStatusLimiter,
    ip,
    "Too many requests",
  );
  if (limited) return limited;

  const supabase = createAdminClient();
  const result = await checkPairingStatus(supabase, redis, params.pairingId);

  if ("error" in result) {
    if (result.error === "not_found")
      return jsonError(404, "not_found", "Pairing session not found");
    return jsonError(410, "code_expired", "Pairing code has expired");
  }

  return jsonSuccess(result);
};
