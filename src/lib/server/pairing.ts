import type { SupabaseClient } from "@supabase/supabase-js";
import { generatePairingCode, generateDeviceToken, hashToken } from "./tokens";

type Redis = {
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
};

type PairingResult = { code: string; pairingId: string; expiresIn: number };

type StatusResult =
  | { paired: false }
  | { paired: true; token: string; userEmail: string }
  | { error: "not_found" | "code_expired" };

type ClaimResult =
  | { deviceId: string; deviceName: string }
  | {
      error:
        | "invalid_code"
        | "code_expired"
        | "already_claimed"
        | "server_error";
    };

// Pairing codes expire after 5 minutes; align Redis TTL so the token lives
// exactly as long as the code that produced it.
const PAIR_REDIS_TTL_SEC = 300;

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
    .select("claimed, expires_at, user_id")
    .eq("id", pairingId)
    .single();

  if (error || !data) return { error: "not_found" };

  if (new Date(data.expires_at) < new Date()) return { error: "code_expired" };

  if (!data.claimed) return { paired: false };

  const token = await redis.get(`pair:token:${pairingId}`);
  if (!token) return { error: "code_expired" };

  // Fetch the claimer's email from auth.users (device displays it in the
  // Cloud submenu so the user can confirm the right account)
  let userEmail = "";
  if (data.user_id) {
    const { data: userRes } = await supabase.auth.admin.getUserById(
      data.user_id,
    );
    userEmail = userRes?.user?.email ?? "";
  }

  return { paired: true, token, userEmail };
}

export async function claimPairingCode(
  supabase: SupabaseClient,
  redis: Redis,
  userId: string,
  code: string,
): Promise<ClaimResult> {
  // Look up code (include claimed codes so we can make the idempotent path work
  // and still reject replay from another account).
  const { data: pairingCode, error: lookupError } = await supabase
    .from("pairing_codes")
    .select("id, hardware_id, claimed, expires_at, user_id")
    .eq("code", code)
    .single();

  if (lookupError || !pairingCode) return { error: "invalid_code" };
  if (new Date(pairingCode.expires_at) < new Date())
    return { error: "code_expired" };

  // Idempotent replay — same user claiming the same code. Safari's stale
  // keep-alive sockets can drop the first response mid-flight; the browser
  // retries and previously got "already_claimed" with no way to recover.
  // Return the same shape as the original success so the UI finishes cleanly.
  if (pairingCode.claimed) {
    if (pairingCode.user_id !== userId) return { error: "already_claimed" };
    const { data: device } = await supabase
      .from("devices")
      .select("id, name")
      .eq("user_id", userId)
      .eq("hardware_id", pairingCode.hardware_id)
      .maybeSingle();
    if (!device) return { error: "already_claimed" };
    return { deviceId: device.id, deviceName: device.name };
  }

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
      .update({
        api_token_hash: tokenHash,
        revoked_at: null,
        paired_at: new Date().toISOString(),
      })
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

  // Store plaintext token in Redis for device to pick up on next poll
  await redis.set(`pair:token:${pairingCode.id}`, token, {
    ex: PAIR_REDIS_TTL_SEC,
  });

  return { deviceId, deviceName };
}
