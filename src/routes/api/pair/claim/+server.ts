import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import {
  redis,
  pairClaimLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { claimPairingCode, type ClaimError } from "$lib/server/pairing";
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
  const limited = await enforceRateLimit(
    pairClaimLimiter,
    `${code}:${ip}`,
    "Too many attempts for this code",
  );
  if (limited) return limited;

  const supabase = createAdminClient();
  // user.email comes from the server-validated session; never read it from
  // the request body (would let the device fake the displayed account).
  const result = await claimPairingCode(supabase, redis, {
    userId: user.id,
    userEmail: user.email ?? null,
    code,
  });

  if ("error" in result) {
    // Record<ClaimError, ...> gives compile-time exhaustiveness: a new
    // variant added to ClaimError in pairing.ts forces an entry here.
    // The `??` fallback is the runtime backstop for any code path that
    // ships without a full typecheck (feature flag, hot-fix) — without
    // it, a missing entry surfaces to clients as the literal "undefined".
    const messages: Record<ClaimError, string> = {
      invalid_code: "Invalid or expired pairing code",
      code_expired:
        "Pairing code has expired. Request a new one from the device.",
      already_claimed: "This code has already been used",
      server_error: "Failed to pair device",
    };
    const status = result.error === "server_error" ? 500 : 400;
    return jsonError(
      status,
      result.error,
      messages[result.error] ?? "Unknown pairing error",
    );
  }

  return jsonSuccess(result);
};
