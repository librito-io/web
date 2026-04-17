import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generatePairingCode, generateDeviceToken, hashToken } from "./tokens";

type Redis = {
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
};

type PairingResult = { code: string; pairingId: string; expiresIn: number };

type StatusResult =
  | { paired: false }
  | { paired: true; token: string; transferSecret: string | null }
  | { error: "not_found" | "code_expired" };

type ClaimResult =
  | { deviceId: string; deviceName: string; transferSecret: string }
  | {
      error:
        | "invalid_code"
        | "code_expired"
        | "already_claimed"
        | "server_error";
    };

export async function requestPairingCode(
  supabase: SupabaseClient,
  hardwareId: string,
  _retried = false,
): Promise<PairingResult> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  const { data, error } = await supabase
    .from("pairing_codes")
    .insert({
      code,
      hardware_id: hardwareId,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // Unique constraint violation = code collision (retry once)
    if (error.code === "23505" && !_retried) {
      return requestPairingCode(supabase, hardwareId, true);
    }
    throw new Error(`Failed to create pairing code: ${error.message}`);
  }

  return { code, pairingId: data.id, expiresIn: 300 };
}

export async function checkPairingStatus(
  supabase: SupabaseClient,
  redis: Redis,
  pairingId: string,
): Promise<StatusResult> {
  const { data, error } = await supabase
    .from("pairing_codes")
    .select("claimed, expires_at, transfer_secret")
    .eq("id", pairingId)
    .single();

  if (error || !data) return { error: "not_found" };

  if (new Date(data.expires_at) < new Date()) return { error: "code_expired" };

  if (!data.claimed) return { paired: false };

  const token = await redis.get(`pair:token:${pairingId}`);
  if (!token) return { error: "code_expired" };

  const transferSecret = await redis.get(`pair:secret:${pairingId}`);

  // Clear transfer_secret from DB after reading (one-time delivery)
  if (data.transfer_secret) {
    await supabase
      .from("pairing_codes")
      .update({ transfer_secret: null })
      .eq("id", pairingId);
  }

  return {
    paired: true,
    token,
    transferSecret: transferSecret ?? data.transfer_secret ?? null,
  };
}

export async function claimPairingCode(
  supabase: SupabaseClient,
  redis: Redis,
  userId: string,
  code: string,
): Promise<ClaimResult> {
  // Look up code (include claimed codes so we can return specific error messages)
  const { data: pairingCode, error: lookupError } = await supabase
    .from("pairing_codes")
    .select("id, hardware_id, claimed, expires_at")
    .eq("code", code)
    .single();

  if (lookupError || !pairingCode) return { error: "invalid_code" };
  if (new Date(pairingCode.expires_at) < new Date())
    return { error: "code_expired" };
  if (pairingCode.claimed) return { error: "already_claimed" };

  // Generate device token
  const token = generateDeviceToken();
  const tokenHash = hashToken(token);

  // Check for existing device (re-pairing case)
  const { data: existing } = await supabase
    .from("devices")
    .select("id, name")
    .eq("user_id", userId)
    .eq("hardware_id", pairingCode.hardware_id)
    .single();

  let deviceId: string;
  let deviceName: string;

  if (existing) {
    // Re-pair: update existing device
    const { error: updateError } = await supabase
      .from("devices")
      .update({ api_token_hash: tokenHash, revoked_at: null })
      .eq("id", existing.id);

    if (updateError) return { error: "server_error" };
    deviceId = existing.id;
    deviceName = existing.name;
  } else {
    // New device
    const { data: device, error: insertError } = await supabase
      .from("devices")
      .insert({
        user_id: userId,
        hardware_id: pairingCode.hardware_id,
        api_token_hash: tokenHash,
      })
      .select("id, name")
      .single();

    if (insertError || !device) return { error: "server_error" };
    deviceId = device.id;
    deviceName = device.name;
  }

  // Mark code as claimed
  const { error: markError } = await supabase
    .from("pairing_codes")
    .update({ claimed: true, user_id: userId })
    .eq("id", pairingCode.id);

  if (markError) return { error: "server_error" };

  // Store plaintext token in Redis for device to pick up on next poll (10 min TTL)
  await redis.set(`pair:token:${pairingCode.id}`, token, { ex: 600 });

  // Generate transfer secret for E2E encryption key exchange
  const transferSecret = randomBytes(32).toString("base64");

  // Store transfer_secret in pairing_codes for status endpoint fallback
  await supabase
    .from("pairing_codes")
    .update({ transfer_secret: transferSecret })
    .eq("id", pairingCode.id);

  // Store in Redis for device pickup alongside token (10 min TTL)
  await redis.set(`pair:secret:${pairingCode.id}`, transferSecret, { ex: 600 });

  return { deviceId, deviceName, transferSecret };
}
