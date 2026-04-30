import type { SupabaseClient } from "@supabase/supabase-js";
import type { SetCommandOptions } from "@upstash/redis";
import { firstRow } from "./rpc";
import { generatePairingCode, generateDeviceToken, hashToken } from "./tokens";

type Redis = {
  set: (
    key: string,
    value: string,
    opts?: SetCommandOptions,
  ) => Promise<unknown>;
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
): Promise<PairingResult> {
  // One-shot collision retry. Postgres unique-violation (23505) on the
  // pairing_codes.code column means we randomly generated a still-live
  // code; re-roll once. Loop avoids exposing a recursion-state param in
  // the public signature.
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIR_REDIS_TTL_SEC * 1000);

    const { data, error } = await supabase
      .from("pairing_codes")
      .insert({
        code,
        hardware_id: hardwareId,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single();

    if (!error) {
      return { code, pairingId: data.id, expiresIn: PAIR_REDIS_TTL_SEC };
    }
    if (error.code !== "23505") {
      throw new Error(`Failed to create pairing code: ${error.message}`);
    }
  }
  throw new Error(
    "Failed to create pairing code: unique-collision retry exhausted",
  );
}

export async function checkPairingStatus(
  supabase: SupabaseClient,
  redis: Redis,
  pairingId: string,
): Promise<StatusResult> {
  const { data, error } = await supabase
    .from("pairing_codes")
    .select("claimed, expires_at, user_email")
    .eq("id", pairingId)
    .single();

  if (error || !data) return { error: "not_found" };

  if (new Date(data.expires_at) < new Date()) return { error: "code_expired" };

  if (!data.claimed) return { paired: false };

  const token = await redis.get(`pair:token:${pairingId}`);
  if (!token) return { error: "code_expired" };

  // user_email denormalised onto pairing_codes — see migration 20260430000006.
  // NULL → "" is the single conversion site for the unknown-email case.
  return { paired: true, token, userEmail: data.user_email ?? "" };
}

// claim_pairing_atomic RPC return shape (one row or empty).
//   row + won=true  → caller won the claim, device row freshly written
//   row + won=false → claim already held by same user (idempotent replay)
//   no row          → claim held by different user, or pairing_id missing
type AtomicClaimRow = {
  device_id: string;
  device_name: string;
  won: boolean;
};

function isAtomicClaimRow(value: unknown): value is AtomicClaimRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.device_id === "string" &&
    typeof row.device_name === "string" &&
    typeof row.won === "boolean"
  );
}

/**
 * Claim a pairing code on behalf of a logged-in user.
 *
 * The race-critical work (conditional UPDATE on pairing_codes + INSERT/UPDATE
 * on devices) lives in the `claim_pairing_atomic` Postgres function, which
 * serializes concurrent callers via pg_advisory_xact_lock. See
 * docs/audits/2026-04-29-server-helpers.md issue B-atomic for design rationale.
 *
 * This function's responsibility is:
 *   1. Resolve `code` → pairing_id + expiry.
 *   2. Generate the device token + hash.
 *   3. Invoke claim_pairing_atomic; map result → ClaimResult.
 *   4. If we won the claim, write the plaintext token to Redis. On Redis
 *      failure, invoke rollback_claim_pairing so the user can retry without
 *      manual recovery.
 *   5. Idempotent-replay callers (won=false) inherit the winner's Redis
 *      token; they do not write Redis themselves (avoids token clobber).
 */
export type ClaimPairingArgs = {
  userId: string;
  /**
   * The session user's email, or null when the auth provider did not return
   * one (phone-only signup, OAuth without email scope). Stamped onto
   * pairing_codes for the device-status poll; surfaces as empty string on
   * read when null. Never trust a body-supplied value here — pass the
   * server-validated session email only.
   */
  userEmail: string | null;
  code: string;
};

export async function claimPairingCode(
  supabase: SupabaseClient,
  redis: Redis,
  { userId, userEmail, code }: ClaimPairingArgs,
): Promise<ClaimResult> {
  const { data: pairingCode, error: lookupError } = await supabase
    .from("pairing_codes")
    .select("id, expires_at")
    .eq("code", code)
    .maybeSingle();

  if (lookupError) return { error: "server_error" };
  if (!pairingCode) return { error: "invalid_code" };
  if (new Date(pairingCode.expires_at) < new Date())
    return { error: "code_expired" };

  const token = generateDeviceToken();
  const tokenHash = hashToken(token);

  // p_user_email denormalised onto pairing_codes — see migration 20260430000006.
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    "claim_pairing_atomic",
    {
      p_user_id: userId,
      p_pairing_id: pairingCode.id,
      p_token_hash: tokenHash,
      p_user_email: userEmail,
    },
  );

  if (rpcError) {
    console.error("pairing.claim_atomic_rpc_failed", {
      pairingId: pairingCode.id,
      error: rpcError.message,
    });
    return { error: "server_error" };
  }

  const row = firstRow<AtomicClaimRow>(rpcRows);
  if (!row) return { error: "already_claimed" };
  if (!isAtomicClaimRow(row)) {
    // Schema drift: the RPC returned a row that does not match our expected
    // shape. Fail closed instead of silently propagating undefined fields.
    console.error("pairing.claim_atomic_rpc_unexpected_shape", {
      pairingId: pairingCode.id,
    });
    return { error: "server_error" };
  }

  // Only the winner writes Redis. Idempotent-replay losers (won=false) trust
  // that the winner has already written; clobbering with a different token
  // would mismatch devices.api_token_hash.
  if (row.won) {
    try {
      await redis.set(`pair:token:${pairingCode.id}`, token, {
        ex: PAIR_REDIS_TTL_SEC,
      });
    } catch (err) {
      console.error("pairing.redis_token_write_failed", {
        pairingId: pairingCode.id,
        error: String(err),
      });
      // Roll back so the user can retry. The rollback function flips
      // claimed=false but does NOT delete the device row (see migration
      // for rationale on the asymmetry).
      const { error: rollbackError } = await supabase.rpc(
        "rollback_claim_pairing",
        { p_pairing_id: pairingCode.id, p_user_id: userId },
      );
      if (rollbackError) {
        console.error("pairing.rollback_rpc_failed", {
          pairingId: pairingCode.id,
          error: rollbackError.message,
        });
      }
      return { error: "server_error" };
    }
  } else {
    // Replay path: the original winner wrote Redis up to PAIR_REDIS_TTL_SEC
    // ago. If that key has already expired or been evicted, the device-side
    // poller would loop on code_expired while we returned a deviceId — a
    // dishonest 200. Surface code_expired to the browser so the user
    // re-initiates pairing with a fresh code.
    const existingToken = await redis.get(`pair:token:${pairingCode.id}`);
    if (!existingToken) return { error: "code_expired" };
  }

  return { deviceId: row.device_id, deviceName: row.device_name };
}
