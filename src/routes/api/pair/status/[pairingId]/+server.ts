import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import {
  redis,
  pairStatusLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { checkPairingStatus } from "$lib/server/pairing";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { UUID_RE } from "$lib/server/validation";

// Extract the plaintext pollSecret from the request. Bearer header is the
// preferred channel (mirrors the device's existing /api/sync pattern);
// ?pollSecret= query param is the fallback for clients that cannot set
// the header. Returns null if neither is present (backward-compat window
// — see checkPairingStatus). See issue #286.
function readPollSecret(request: Request, url: URL): string | null {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(\S+)$/);
    if (match) return match[1];
  }
  return url.searchParams.get("pollSecret");
}

export const GET: RequestHandler = async ({
  params,
  url,
  request,
  getClientAddress,
}) => {
  if (!UUID_RE.test(params.pairingId)) {
    return jsonError(404, "not_found", "Pairing session not found");
  }

  // Rate limit by IP
  const ip = getClientAddress();
  const limited = await enforceRateLimit(
    pairStatusLimiter,
    ip,
    "Too many requests",
  );
  if (limited) return limited;

  const pollSecret = readPollSecret(request, url);

  const supabase = createAdminClient();
  const result = await checkPairingStatus(
    supabase,
    redis,
    params.pairingId,
    pollSecret,
  );

  if ("error" in result) {
    if (result.error === "not_found")
      return jsonError(404, "not_found", "Pairing session not found");
    if (result.error === "poll_secret_mismatch")
      return jsonError(401, "unauthorized", "Pairing session unauthorized");
    return jsonError(410, "code_expired", "Pairing code has expired");
  }

  return jsonSuccess(result);
};
