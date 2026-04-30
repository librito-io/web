import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { redis, pairClaimLimiter } from "$lib/server/ratelimit";
import { claimPairingCode } from "$lib/server/pairing";
import { jsonError, jsonSuccess } from "$lib/server/errors";

export const POST: RequestHandler = async ({
  request,
  locals: { safeGetSession },
  getClientAddress,
}) => {
  // Auth check — must be logged in
  const { user } = await safeGetSession();
  if (!user) return jsonError(401, "unauthorized", "Must be logged in");

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON");
  }

  const code = body.code?.trim();
  if (!code || !/^\d{6}$/.test(code)) {
    return jsonError(400, "invalid_request", "code must be a 6-digit string");
  }

  // Rate limit by code:IP
  const ip = getClientAddress();
  const { success, reset } = await pairClaimLimiter.limit(`${code}:${ip}`);
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return jsonError(
      429,
      "rate_limited",
      "Too many attempts for this code",
      retryAfter,
    );
  }

  const supabase = createAdminClient();
  // user.email comes from the server-validated session; never read it from
  // the request body (would let the device fake the displayed account).
  const result = await claimPairingCode(supabase, redis, {
    userId: user.id,
    userEmail: user.email ?? null,
    code,
  });

  if ("error" in result) {
    const messages: Record<string, string> = {
      invalid_code: "Invalid or expired pairing code",
      code_expired:
        "Pairing code has expired. Request a new one from the device.",
      already_claimed: "This code has already been used",
      server_error: "Failed to pair device",
    };
    const status = result.error === "server_error" ? 500 : 400;
    return jsonError(status, result.error, messages[result.error]);
  }

  return jsonSuccess(result);
};
