import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import {
  pairRequestLimiter,
  pairRequestPerHardwareLimiter,
  enforceRateLimit,
} from "$lib/server/ratelimit";
import { requestPairingCode } from "$lib/server/pairing";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { UUID_RE } from "$lib/server/validation";
import * as Sentry from "@sentry/sveltekit";

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  // Layer 1: per-IP. Cheap; bounds body-parsing cost for IP-bound floods.
  const ip = getClientAddress();
  const ipLimited = await enforceRateLimit(
    pairRequestLimiter,
    ip,
    "Too many requests",
  );
  if (ipLimited) return ipLimited;

  let body: {
    hardwareId?: string;
    // Optional device identity (issue #505). Validation/coercion lives in
    // requestPairingCode: unknown deviceType coerces to 'papers3', model is
    // trimmed/capped. We pass through only when the type is a string so a
    // non-string (number, object) becomes the silent default rather than a
    // coerced "[object Object]". PaperS3 firmware sends neither field.
    deviceType?: unknown;
    deviceModel?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    // Malformed client JSON → 400, not a server fault.
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

  // Layer 2: per-hardwareId. Bounds per-device damage when the attacker
  // rotates IPs to bypass layer 1 — the unique index on `pairing_codes`
  // covers `code`, not `hardware_id`, so per-hardware flooding is
  // otherwise only bounded by the 5-minute TTL on each row.
  const hwLimited = await enforceRateLimit(
    pairRequestPerHardwareLimiter,
    body.hardwareId,
    "Too many requests",
  );
  if (hwLimited) return hwLimited;

  try {
    const supabase = createAdminClient();
    const deviceType =
      typeof body.deviceType === "string" ? body.deviceType : null;
    const deviceModel =
      typeof body.deviceModel === "string" ? body.deviceModel : null;
    const result = await requestPairingCode(
      supabase,
      body.hardwareId,
      deviceType,
      deviceModel,
    );
    return jsonSuccess(result);
  } catch (err) {
    Sentry.captureException(err);
    await Sentry.flush(2000);
    return jsonError(500, "server_error", "Failed to generate pairing code");
  }
};
