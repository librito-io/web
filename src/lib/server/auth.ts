import type { SupabaseClient, User } from "@supabase/supabase-js";
import { error, type RequestEvent } from "@sveltejs/kit";
import { hashToken } from "./tokens";
import { jsonError } from "./errors";

export interface AuthenticatedDevice {
  id: string;
  userId: string;
  hardwareId: string;
  name: string;
}

export type AuthErrorCode = "missing_token" | "invalid_token" | "token_revoked";

type AuthResult = { device: AuthenticatedDevice } | { error: AuthErrorCode };

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  missing_token: "Authorization header with Bearer token required",
  invalid_token: "Invalid device token",
  token_revoked: "Device token has been revoked. Re-pair the device.",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// All auth errors map to 401 (per RFC 7235 — missing/invalid/revoked
// credentials all mean "you are not authenticated"). Used by every
// authenticated device endpoint. /api/device/unpair is the one
// exception — it treats invalid/revoked as success for idempotency.
export function authErrorResponse(code: AuthErrorCode): Response {
  return jsonError(401, code, AUTH_ERROR_MESSAGES[code]);
}

// Narrows `event.locals.user` to non-null inside /app/** route handlers
// (page loaders, form actions, +server.ts endpoints). The appAuthGuard
// hook in hooks.server.ts populates locals.user before any /app/**
// handler runs; a null read here means the hook regressed or the
// helper is being called outside the guarded prefix.
//
// 500 is intentional and load-bearing — this is a server-side
// contract violation (hook missing or misordered), not a client auth
// failure. Surfacing as 500 fires Sentry, alerts ops, and pages
// someone; a silent fallback to 401 would hide the bug.
export function requireUser(event: RequestEvent): User {
  if (!event.locals.user) {
    error(500, "requireUser called outside /app/** guarded route");
  }
  return event.locals.user;
}

export async function authenticateDevice(
  request: Request,
  supabase: SupabaseClient,
): Promise<AuthResult> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "missing_token" };
  }

  const token = authHeader.slice(7);
  // Skip SHA-256 + DB lookup on garbage tokens (credential-stuffing scans).
  if (!token.startsWith("sk_device_")) {
    return { error: "invalid_token" };
  }

  const tokenHash = hashToken(token);

  const { data: device, error } = await supabase
    .from("devices")
    .select("id, user_id, hardware_id, name, revoked_at")
    .eq("api_token_hash", tokenHash)
    .single();

  if (error || !device) {
    return { error: "invalid_token" };
  }

  if (device.revoked_at) {
    return { error: "token_revoked" };
  }

  // Defense-in-depth: device.id and device.user_id flow into raw PostgREST
  // filter strings (sync.ts .or()/.eq()). UUID format is enforced by the
  // schema, but validating at the auth boundary makes the trust contract
  // explicit and survives future schema relaxations.
  if (!UUID_RE.test(device.id) || !UUID_RE.test(device.user_id)) {
    return { error: "invalid_token" };
  }

  return {
    device: {
      id: device.id,
      userId: device.user_id,
      hardwareId: device.hardware_id,
      name: device.name,
    },
  };
}
