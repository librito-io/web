import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deterministic test values for the pollSecret challenge. The plaintext
// secret and its SHA-256 hash are paired here so test assertions can verify
// either side: the API response carries the plaintext, the DB column
// carries the hash. Hash is the actual SHA-256 of "test_poll_secret_plaintext"
// so production code calling hashPollSecret against the mock plaintext gets
// the matching hash deterministically (constant-time-equal path).
const TEST_POLL_SECRET = "test_poll_secret_plaintext";
const TEST_POLL_SECRET_HASH =
  "3d2905d936ac1b763e8f5ae7e627241658a8222c7ccfd9580e0315184138ce90";

vi.mock("$lib/server/tokens", async () => {
  const { createHash } = await import("crypto");
  return {
    generatePairingCode: vi.fn(() => "482901"),
    generateDeviceToken: vi.fn(() => "sk_device_test_token_abc123"),
    hashToken: vi.fn(
      () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    ),
    generatePollSecret: vi.fn(() => TEST_POLL_SECRET),
    // Real SHA-256 so any plaintext the production code feeds in
    // (including non-mock values an attacker would present) hashes
    // correctly — mismatch tests need a non-canned hash function.
    hashPollSecret: vi.fn((s: string) =>
      createHash("sha256").update(s).digest("hex"),
    ),
  };
});

import {
  requestPairingCode,
  checkPairingStatus,
  claimPairingCode,
  MAX_CLAIM_ATTEMPTS_PER_CODE,
} from "$lib/server/pairing";
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";

let logWrites: Record<string, unknown>[];
beforeEach(() => {
  logWrites = [];
  __setTestDestination((line) => logWrites.push(JSON.parse(line)));
});
afterEach(() => __resetTestDestination());
import { createMockSupabase, createMockRedis } from "../helpers";

describe("requestPairingCode", () => {
  it("inserts a pairing code and returns code + pairingId + expiresIn + pollSecret", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("pairing_codes.insert", {
      data: { id: "pairing-uuid-123" },
      error: null,
    });

    const result = await requestPairingCode(supabase, "hw-device-1");

    expect(result).toEqual({
      code: "482901",
      pairingId: "pairing-uuid-123",
      expiresIn: 300,
      pollSecret: TEST_POLL_SECRET,
    });
  });

  it("stores the hashed pollSecret (never the plaintext) on the inserted row", async () => {
    // Defends against a future refactor leaking the plaintext to the DB
    // column. The hash → token-leak resistance of issue #286 step 2 depends
    // on this invariant.
    const supabase = createMockSupabase();
    supabase._results.set("pairing_codes.insert", {
      data: { id: "pairing-uuid-123" },
      error: null,
    });

    await requestPairingCode(supabase, "hw-device-1");

    expect(supabase._insertCalls).toHaveLength(1);
    const inserted = supabase._insertCalls[0].payload as Record<
      string,
      unknown
    >;
    expect(inserted.poll_secret_hash).toBe(TEST_POLL_SECRET_HASH);
    expect(inserted.poll_secret_hash).not.toBe(TEST_POLL_SECRET);
  });

  it("throws on database error", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("pairing_codes.insert", {
      data: null,
      error: { code: "42P01", message: "table not found" },
    });

    await expect(requestPairingCode(supabase, "hw-1")).rejects.toThrow();
  });

  it("retries once on unique-violation and returns the second attempt", async () => {
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("pairing_codes.insert", [
      { data: null, error: { code: "23505", message: "unique violation" } },
      { data: { id: "pairing-uuid-retry" }, error: null },
    ]);

    const result = await requestPairingCode(supabase, "hw-1");

    expect(result).toEqual({
      code: "482901",
      pairingId: "pairing-uuid-retry",
      expiresIn: 300,
      pollSecret: TEST_POLL_SECRET,
    });
  });

  it("throws after two consecutive unique-violations (retry exhausted)", async () => {
    const supabase = createMockSupabase();
    supabase._resultsQueue.set("pairing_codes.insert", [
      { data: null, error: { code: "23505", message: "unique violation" } },
      { data: null, error: { code: "23505", message: "unique violation" } },
    ]);

    await expect(requestPairingCode(supabase, "hw-1")).rejects.toThrow(
      /retry exhausted/,
    );
  });
});

describe("checkPairingStatus", () => {
  it("returns paired: false when code is unclaimed", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: false,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: null,
      },
      error: null,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({ paired: false });
  });

  it("returns paired: true with token and userEmail when code is claimed", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: "claimer@example.com",
      },
      error: null,
    });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 300,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      userEmail: "claimer@example.com",
    });
  });

  it("returns paired: true with empty userEmail when user_email column is null", async () => {
    // Read-side fallback for the unknown-email case (operator wired phone
    // or OAuth-without-email-scope auth, or schema drift if claim ever
    // fails to stamp). Single NULL → "" conversion site lives here.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: null,
      },
      error: null,
    });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 300,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      userEmail: "",
    });
  });

  it("returns code_expired when the pairing token has disappeared from redis", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: "claimer@example.com",
      },
      error: null,
    });

    const result = await checkPairingStatus(supabase, redis, "pairing-uuid");
    expect(result).toEqual({ error: "code_expired" });
  });

  it("returns not_found when pairingId does not exist", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: { code: "PGRST116" },
    });

    const result = await checkPairingStatus(supabase, redis, "nonexistent");
    expect(result).toEqual({ error: "not_found" });
  });

  it("returns expired when code has passed its expiry", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: false,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
      error: null,
    });

    const result = await checkPairingStatus(supabase, redis, "expired-uuid");
    expect(result).toEqual({ error: "code_expired" });
  });

  // ---- pollSecret challenge (issue #286 step 2) ----

  it("admits caller when pollSecret matches the stored hash", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: "claimer@example.com",
        poll_secret_hash: TEST_POLL_SECRET_HASH,
      },
      error: null,
    });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 300,
    });

    const result = await checkPairingStatus(
      supabase,
      redis,
      "pairing-uuid",
      TEST_POLL_SECRET,
    );
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      userEmail: "claimer@example.com",
    });
  });

  it("returns poll_secret_mismatch when the presented secret hashes to a different value", async () => {
    // Wrong-secret path — the token-leak gate from issue #286 step 2.
    // The row must NOT escalate to paired/token-emit even though it
    // is in fact claimed, and the log must carry the redacted prefix
    // (no full pairingId).
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: "claimer@example.com",
        poll_secret_hash: TEST_POLL_SECRET_HASH,
      },
      error: null,
    });
    await redis.set("pair:token:pairing-uuid", "sk_device_test_token", {
      ex: 300,
    });

    const result = await checkPairingStatus(
      supabase,
      redis,
      "pairing-uuid-1234",
      "wrong-secret",
    );
    expect(result).toEqual({ error: "poll_secret_mismatch" });
    expect(logWrites).toContainEqual(
      expect.objectContaining({
        event: "pairing.poll_secret_mismatch",
        pairingIdPrefix: "pairing-",
      }),
    );
    const mismatch = logWrites.find(
      (w) => w.event === "pairing.poll_secret_mismatch",
    );
    expect(mismatch).not.toHaveProperty("pairingId");
  });

  it("proceeds and logs poll_secret_absent when caller omits secret on a row that has a hash (backward-compat)", async () => {
    // Backward-compat window: pre-update firmware does not forward the
    // secret. Today we admit and log; phase 3 follow-up flips this to
    // refuse once firmware has rolled out.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = "pairing-uuid-1234";
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: "claimer@example.com",
        poll_secret_hash: TEST_POLL_SECRET_HASH,
      },
      error: null,
    });
    await redis.set(`pair:token:${pairingId}`, "sk_device_test_token", {
      ex: 300,
    });

    const result = await checkPairingStatus(supabase, redis, pairingId, null);
    expect(result).toEqual({
      paired: true,
      token: "sk_device_test_token",
      userEmail: "claimer@example.com",
    });
    expect(logWrites).toContainEqual(
      expect.objectContaining({
        event: "pairing.poll_secret_absent",
        pairingIdPrefix: "pairing-",
      }),
    );
  });

  it("proceeds normally on pre-migration row (poll_secret_hash NULL) regardless of provided secret", async () => {
    // Rows minted before the column existed survive their 5-min TTL. The
    // challenge gate must not refuse them — there is no hash to verify
    // against — but record so the rollout-window count is observable.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = "pairing-uuid-1234";
    supabase._results.set("pairing_codes.select", {
      data: {
        claimed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        user_email: "claimer@example.com",
        poll_secret_hash: null,
      },
      error: null,
    });
    await redis.set(`pair:token:${pairingId}`, "sk_device_test_token", {
      ex: 300,
    });

    const withSecret = await checkPairingStatus(
      supabase,
      redis,
      pairingId,
      TEST_POLL_SECRET,
    );
    expect(withSecret).toMatchObject({ paired: true });
    expect(logWrites).toContainEqual(
      expect.objectContaining({
        event: "pairing.poll_secret_missing_on_row",
      }),
    );

    const withoutSecret = await checkPairingStatus(
      supabase,
      redis,
      pairingId,
      null,
    );
    expect(withoutSecret).toMatchObject({ paired: true });
  });
});

// Helper: stash a successful pairing_codes lookup against a future expiry so
// the per-test setup focuses on the RPC return shape (the part each scenario
// actually exercises). Returns the pairing_id used so tests can assert
// rpc args / Redis keys.
function setupValidLookup(
  supabase: ReturnType<typeof createMockSupabase>,
): string {
  const pairingId = "pairing-uuid";
  supabase._results.set("pairing_codes.select", {
    data: {
      id: pairingId,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
    error: null,
  });
  return pairingId;
}

// Helper: invoke claimPairingCode with canonical args, allowing per-test
// overrides. Centralises the options-bag shape so signature additions touch
// one place. Tests asserting wire-shape (the first one) keep their explicit
// literals.
function callClaim(
  supabase: ReturnType<typeof createMockSupabase>,
  redis: ReturnType<typeof createMockRedis>,
  overrides: Partial<{
    userId: string;
    userEmail: string | null;
    code: string;
  }> = {},
) {
  return claimPairingCode(supabase, redis, {
    userId: "user-uuid",
    userEmail: "user@example.com",
    code: "482901",
    ...overrides,
  });
}

describe("claimPairingCode", () => {
  it("delegates atomic claim to claim_pairing_atomic RPC; winner writes Redis", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = setupValidLookup(supabase);
    const rpcSpy = vi.spyOn(supabase, "rpc");
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: true,
          expired: false,
        },
      ],
      error: null,
    });

    // Wire-shape test: keep explicit options-bag literal so a future
    // signature change here is loud, not silent (callClaim helper hides args).
    const result = await claimPairingCode(supabase, redis, {
      userId: "user-uuid",
      userEmail: "user@example.com",
      code: "482901",
    });

    expect(result).toEqual({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
    expect(rpcSpy).toHaveBeenCalledWith("claim_pairing_atomic", {
      p_user_id: "user-uuid",
      p_pairing_id: pairingId,
      p_token_hash:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      p_user_email: "user@example.com",
      p_max_attempts: MAX_CLAIM_ATTEMPTS_PER_CODE,
    });
    expect(redis.set).toHaveBeenCalledWith(
      `pair:token:${pairingId}`,
      "sk_device_test_token_abc123",
      { ex: 300 },
    );
  });

  it("idempotent replay (won=false) returns the existing device WITHOUT writing Redis", async () => {
    // Same-user retry path. Browser's first claim succeeded but the response
    // dropped (Safari keep-alive); the second request must NOT clobber the
    // winner's Redis token (mismatch with devices.api_token_hash would 401
    // the device on next /api/sync).
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: false,
          expired: false,
        },
      ],
      error: null,
    });
    // Original winner's token still alive in Redis — replay must succeed.
    await redis.set(`pair:token:${pairingId}`, "sk_device_winner_token", {
      ex: 300,
    });

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
    // The replay-side mutation must not call redis.set; we only assert
    // setup's pre-seed call here, no post-RPC writes.
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      `pair:token:${pairingId}`,
      "sk_device_winner_token",
      { ex: 300 },
    );
  });

  it("replay after Redis TTL expiry returns code_expired (no dishonest 200)", async () => {
    // Replay path with the original winner's Redis token already evicted.
    // Browser must NOT receive a deviceId while the device-side poller is
    // stuck on code_expired; force the user back through a fresh claim.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: false,
          expired: false,
        },
      ],
      error: null,
    });
    // Redis empty: pair:token:* was never written or has expired.

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "code_expired" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("returns already_claimed when RPC returns no rows (different user holds claim)", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [],
      error: null,
    });

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "already_claimed" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("returns already_claimed when RPC returns null (defensive)", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: null,
      error: null,
    });

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "already_claimed" });
  });

  it("returns code_expired for expired codes (short-circuits RPC)", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: {
        id: "old-uuid",
        expires_at: new Date(Date.now() - 5000).toISOString(),
      },
      error: null,
    });
    const rpcSpy = vi.spyOn(supabase, "rpc");

    const result = await callClaim(supabase, redis, { code: "111111" });

    expect(result).toEqual({ error: "code_expired" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("returns invalid_code when code does not exist", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: null,
    });

    const result = await callClaim(supabase, redis, { code: "999999" });

    expect(result).toEqual({ error: "invalid_code" });
  });

  it("returns server_error when pairing_codes lookup itself errors", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    supabase._results.set("pairing_codes.select", {
      data: null,
      error: { code: "08006", message: "connection failure" },
    });

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "server_error" });
  });

  it("returns server_error when claim_pairing_atomic RPC errors", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: null,
      error: { message: "connection failure" },
    });

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "server_error" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("returns server_error when RPC returns a row missing required fields (schema drift)", async () => {
    // Defends against the cast at the firstRow boundary: a future RPC schema
    // change that drops or renames a column must not silently emit a
    // deviceId/deviceName=undefined response.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [{ device_id: "device-uuid" }], // missing device_name + won
      error: null,
    });

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "server_error" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("rolls back via rollback_claim_pairing RPC when Redis write throws", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: true,
          expired: false,
        },
      ],
      error: null,
    });
    redis.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const rpcSpy = vi.spyOn(supabase, "rpc");
    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "server_error" });
    // Two RPC calls: claim_pairing_atomic then rollback_claim_pairing.
    expect(rpcSpy).toHaveBeenCalledTimes(2);
    expect(rpcSpy).toHaveBeenNthCalledWith(2, "rollback_claim_pairing", {
      p_pairing_id: pairingId,
      p_user_id: "user-uuid",
    });
  });

  it("returns server_error and logs when rollback_claim_pairing RPC itself errors", async () => {
    // Redis fails -> rollback is invoked -> rollback RPC also fails. The
    // outer return must still surface server_error (not leak success), and
    // we should log both failures so an operator can correlate them.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: true,
          expired: false,
        },
      ],
      error: null,
    });
    supabase._results.set("rpc.rollback_claim_pairing", {
      data: null,
      error: { message: "rollback connection failure" },
    });
    redis.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const rpcSpy = vi.spyOn(supabase, "rpc");
    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "server_error" });
    expect(rpcSpy).toHaveBeenCalledTimes(2);
    expect(rpcSpy).toHaveBeenNthCalledWith(2, "rollback_claim_pairing", {
      p_pairing_id: pairingId,
      p_user_id: "user-uuid",
    });
    // Both failure events must be logged (Redis + rollback RPC).
    expect(logWrites).toContainEqual(
      expect.objectContaining({ event: "pairing.redis_token_write_failed" }),
    );
    expect(logWrites).toContainEqual(
      expect.objectContaining({ event: "pairing.rollback_rpc_failed" }),
    );

    // pairingId must be scrubbed to first-8-char prefix (issue #286 step 1).
    // A leaked full pairingId within the 5-min TTL is enough to fetch the
    // plaintext device token from an unauth endpoint. Guard the redaction
    // here so a future contributor reintroducing the raw id fails CI.
    const redisWriteFailLog = logWrites.find(
      (w) => w.event === "pairing.redis_token_write_failed",
    );
    const rollbackFailLog = logWrites.find(
      (w) => w.event === "pairing.rollback_rpc_failed",
    );
    expect(redisWriteFailLog).toMatchObject({
      pairingIdPrefix: pairingId.slice(0, 8),
    });
    expect(redisWriteFailLog).not.toHaveProperty("pairingId");
    expect(rollbackFailLog).toMatchObject({
      pairingIdPrefix: pairingId.slice(0, 8),
    });
    expect(rollbackFailLog).not.toHaveProperty("pairingId");
  });

  it("threads MAX_CLAIM_ATTEMPTS_PER_CODE through as p_max_attempts (issue #260)", async () => {
    // The cap value lives in TS so SQL and TS stay aligned via the RPC arg.
    // If a future refactor forgets to wire it through (or hardcodes a literal
    // instead of importing the constant), this test fails loudly.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: true,
          expired: false,
        },
      ],
      error: null,
    });
    const rpcSpy = vi.spyOn(supabase, "rpc");

    await callClaim(supabase, redis);

    expect(rpcSpy).toHaveBeenCalledWith(
      "claim_pairing_atomic",
      expect.objectContaining({
        p_max_attempts: MAX_CLAIM_ATTEMPTS_PER_CODE,
      }),
    );
  });

  it("returns code_expired when RPC signals cap exceeded (expired=true)", async () => {
    // Sentinel row shape from migration 20260520000001: expired=true with
    // NULL device fields. Caller must surface this as code_expired and
    // touch neither Redis nor rollback (no claim was committed).
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: null,
          device_name: null,
          won: false,
          expired: true,
        },
      ],
      error: null,
    });
    const rpcSpy = vi.spyOn(supabase, "rpc");

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "code_expired" });
    expect(redis.set).not.toHaveBeenCalled();
    // Exactly one RPC call: claim_pairing_atomic. No rollback, no replay
    // Redis read — the cap path must short-circuit entirely.
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("returns server_error on cap row with non-NULL device fields (schema drift defense)", async () => {
    // Any expired=true row with a populated device_id is unreachable per
    // the migration's RETURN QUERY shape. Treat it as drift so an
    // accidental future RPC change cannot accidentally surface a deviceId
    // alongside an expired sentinel.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: false,
          expired: true,
        },
      ],
      error: null,
    });

    const result = await callClaim(supabase, redis);

    expect(result).toEqual({ error: "server_error" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("acceptance: 11 attempts on the same code succeed/refuse per cap (issue #260)", async () => {
    // Unit-level emulation of the per-code global cap. Per CLAUDE.md mocks,
    // the IP-distinct angle lives outside claimPairingCode (route-level
    // pairClaimLimiter keys on ${code}:${ip}); claimPairingCode itself is
    // IP-blind. This test confirms the wired behavior: first
    // MAX_CLAIM_ATTEMPTS_PER_CODE invocations succeed, MAX+1 is refused
    // with code_expired regardless of caller identity.
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    const pairingId = setupValidLookup(supabase);
    // Pre-seed Redis so the replay branch (won=false) does not surface
    // code_expired from the Redis-missing fallback.
    await redis.set(`pair:token:${pairingId}`, "sk_device_test_token", {
      ex: 300,
    });
    const winRow = {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: true,
          expired: false,
        },
      ],
      error: null,
    };
    const replayRow = {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: false,
          expired: false,
        },
      ],
      error: null,
    };
    const expiredRow = {
      data: [
        {
          device_id: null,
          device_name: null,
          won: false,
          expired: true,
        },
      ],
      error: null,
    };

    for (let i = 0; i < MAX_CLAIM_ATTEMPTS_PER_CODE; i++) {
      supabase._results.set(
        "rpc.claim_pairing_atomic",
        i === 0 ? winRow : replayRow,
      );
      const result = await callClaim(supabase, redis);
      expect(result).toEqual({
        deviceId: "device-uuid",
        deviceName: "Librito",
      });
    }

    supabase._results.set("rpc.claim_pairing_atomic", expiredRow);
    const refused = await callClaim(supabase, redis);
    expect(refused).toEqual({ error: "code_expired" });
  });

  it("does NOT invoke rollback when Redis write succeeds", async () => {
    const supabase = createMockSupabase();
    const redis = createMockRedis();
    setupValidLookup(supabase);
    supabase._results.set("rpc.claim_pairing_atomic", {
      data: [
        {
          device_id: "device-uuid",
          device_name: "Librito",
          won: true,
          expired: false,
        },
      ],
      error: null,
    });
    const rpcSpy = vi.spyOn(supabase, "rpc");

    await callClaim(supabase, redis);

    // Exactly one RPC call: claim_pairing_atomic. No rollback.
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      "claim_pairing_atomic",
      expect.any(Object),
    );
  });
});
