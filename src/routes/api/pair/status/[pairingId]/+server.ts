import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { redis, pairStatusLimiter } from "$lib/server/ratelimit";
import { checkPairingStatus } from "$lib/server/pairing";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const GET: RequestHandler = async ({ params, getClientAddress }) => {
  // Rate limit by IP
  const ip = getClientAddress();
  const { success, reset } = await pairStatusLimiter.limit(ip);
  if (!success) {
    const retryAfter = Math.ceil((reset - Date.now()) / 1000);
    return jsonError(429, "rate_limited", "Too many requests", retryAfter);
  }

  const supabase = createAdminClient();
  const result = await checkPairingStatus(supabase, redis, params.pairingId);

  if ("error" in result) {
    if (result.error === "not_found")
      return jsonError(404, "not_found", "Pairing session not found");
    if (result.error === "code_expired")
      return jsonError(410, "code_expired", "Pairing code has expired");
  }

  return jsonSuccess(result);
};
