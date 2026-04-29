import type { SupabaseClient } from "@supabase/supabase-js";
import type { SetCommandOptions } from "@upstash/redis";
import { generatePairingCode, generateDeviceToken, hashToken } from "./tokens";

type Redis = {
  set: (
    key: string,
    value: string,
    opts?: SetCommandOptions,
  ) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<unknown>;
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

// Post-condition guarantee: every non-success exit leaves
// pairing_codes.claimed=false and either no Redis token or a self-expiring
// orphan (claimed=false blocks checkPairingStatus from returning it). The
// token in Redis on success matches devices.api_token_hash, even under
// concurrent claims — only the conditional-UPDATE winner writes Redis.
export async function claimPairingCode(
  supabase: SupabaseClient,
  redis: Redis,
  userId: string,
  code: string,
): Promise<ClaimResult> {
  // 1. Look up code (include claimed codes so the idempotent-replay path works
  // and replay from another account is still rejected).
  const { data: pairingCode, error: lookupError } = await supabase
    .from("pairing_codes")
    .select("id, hardware_id, claimed, expires_at, user_id")
    .eq("code", code)
    .single();

  if (lookupError || !pairingCode) return { error: "invalid_code" };
  if (new Date(pairingCode.expires_at) < new Date())
    return { error: "code_expired" };

  // 2. Idempotent replay — same user claiming the same code. Safari's stale
  // keep-alive sockets can drop the first response mid-flight; the browser
  // retries and previously got "already_claimed" with no way to recover.
  if (pairingCode.claimed) {
    return replayClaim(supabase, userId, pairingCode);
  }

  // 3. Generate device token + hash.
  const token = generateDeviceToken();
  const tokenHash = hashToken(token);

  // 4. Atomic claim transition — UPDATE only matches when claimed=false.
  // Concurrent claims serialize at the row lock; only one racer transitions
  // and gets the RETURNING row. Losers fall to the replay path. This MUST
  // run before the Redis write, otherwise concurrent racers clobber each
  // other's Redis tokens and the device fetches a token whose hash isn't in
  // the devices row.
  const { data: claimRow, error: claimError } = await supabase
    .from("pairing_codes")
    .update({ claimed: true, user_id: userId })
    .eq("id", pairingCode.id)
    .eq("claimed", false)
    .select("id")
    .maybeSingle();

  if (claimError) return { error: "server_error" };
  if (!claimRow) {
    const { data: winner } = await supabase
      .from("pairing_codes")
      .select("user_id")
      .eq("id", pairingCode.id)
      .single();
    if (!winner || winner.user_id !== userId)
      return { error: "already_claimed" };
    return replayClaim(supabase, userId, pairingCode);
  }

  // 5. Write Redis after winning the claim. If Redis fails, roll back the
  // claim flag so the user can retry without manual recovery.
  try {
    await redis.set(`pair:token:${pairingCode.id}`, token, {
      ex: PAIR_REDIS_TTL_SEC,
    });
  } catch (err) {
    console.error("pairing.redis_token_write_failed", {
      pairingId: pairingCode.id,
      error: String(err),
    });
    await rollbackClaim(supabase, pairingCode.id);
    return { error: "server_error" };
  }

  // 6. Provision device. On failure, roll back the claim and best-effort
  // delete the orphaned Redis token (claimed=false already blocks the device
  // from reaching it via status poll, so cleanup is tidiness, not safety).
  const { data: existing } = await supabase
    .from("devices")
    .select("id, name")
    .eq("user_id", userId)
    .eq("hardware_id", pairingCode.hardware_id)
    .maybeSingle();

  let deviceId: string;
  let deviceName: string;

  if (existing) {
    const { error: updateError } = await supabase
      .from("devices")
      .update({
        api_token_hash: tokenHash,
        revoked_at: null,
        paired_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (updateError) {
      await rollbackClaim(supabase, pairingCode.id);
      await cleanupRedisToken(redis, pairingCode.id);
      return { error: "server_error" };
    }
    deviceId = existing.id;
    deviceName = existing.name;
  } else {
    const { data: device, error: insertError } = await supabase
      .from("devices")
      .insert({
        user_id: userId,
        hardware_id: pairingCode.hardware_id,
        api_token_hash: tokenHash,
      })
      .select("id, name")
      .single();

    if (insertError || !device) {
      await rollbackClaim(supabase, pairingCode.id);
      await cleanupRedisToken(redis, pairingCode.id);
      return { error: "server_error" };
    }
    deviceId = device.id;
    deviceName = device.name;
  }

  return { deviceId, deviceName };
}

async function cleanupRedisToken(
  redis: Redis,
  pairingId: string,
): Promise<void> {
  try {
    await redis.del(`pair:token:${pairingId}`);
  } catch (err) {
    console.error("pairing.redis_token_cleanup_failed", {
      pairingId,
      error: String(err),
    });
  }
}

async function replayClaim(
  supabase: SupabaseClient,
  userId: string,
  pairingCode: { user_id: string | null; hardware_id: string },
): Promise<ClaimResult> {
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

async function rollbackClaim(
  supabase: SupabaseClient,
  pairingId: string,
): Promise<void> {
  const { error } = await supabase
    .from("pairing_codes")
    .update({ claimed: false, user_id: null })
    .eq("id", pairingId);
  if (error) {
    console.error("pairing.claim_rollback_failed", {
      pairingId,
      error: error.message,
    });
  }
}
