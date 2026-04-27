import { describe, it, expect } from "vitest";
import { jwtVerify, importJWK } from "jose";
import {
  mintRealtimeToken,
  REALTIME_TOKEN_TTL_SECONDS,
} from "$lib/server/realtime";
import { DEV_STANDBY_JWK, DEV_KID } from "../fixtures/dev-jwk";

const SUPABASE_URL = "https://test-proj.supabase.co";

describe("mintRealtimeToken", () => {
  it("returns expiresIn of exactly 86400 seconds", async () => {
    const { expiresIn } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });
    expect(expiresIn).toBe(86400);
    expect(REALTIME_TOKEN_TTL_SECONDS).toBe(86400);
  });

  it("signs an ES256 JWT with kid header from JWK + role/sub/aud/exp/iat/device_id claims", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const deviceId = "22222222-2222-2222-2222-222222222222";
    const before = Math.floor(Date.now() / 1000);
    const { token } = await mintRealtimeToken({
      userId,
      deviceId,
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });
    const after = Math.floor(Date.now() / 1000);

    // Verify with the public side of the same key
    const { d, key_ops, ...publicJwk } = DEV_STANDBY_JWK;
    const publicKey = await importJWK(publicJwk, "ES256");

    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      audience: "authenticated",
    });

    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.typ).toBe("JWT");
    expect(protectedHeader.kid).toBe(DEV_KID);
    expect(payload.iss).toBe(`${SUPABASE_URL}/auth/v1`);
    expect(payload.sub).toBe(userId);
    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
    expect(payload.device_id).toBe(deviceId);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.iat as number).toBeGreaterThanOrEqual(before);
    expect(payload.iat as number).toBeLessThanOrEqual(after);
    expect((payload.exp as number) - (payload.iat as number)).toBe(86400);
  });

  it("throws when privateJwk is missing the `d` private component", async () => {
    const { d, ...publicOnly } = DEV_STANDBY_JWK;
    await expect(
      mintRealtimeToken({
        userId: "11111111-1111-1111-1111-111111111111",
        deviceId: "22222222-2222-2222-2222-222222222222",
        privateJwk: publicOnly as typeof DEV_STANDBY_JWK,
        supabaseUrl: SUPABASE_URL,
      }),
    ).rejects.toThrow(/private component|d field|missing/i);
  });

  it("rejects verification with a different keypair", async () => {
    const { token } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });
    const { generateKeyPair, exportJWK } = await import("jose");
    const otherKp = await generateKeyPair("ES256", { extractable: true });
    const otherJwk = await exportJWK(otherKp.publicKey);
    const otherKey = await importJWK(otherJwk, "ES256");
    await expect(
      jwtVerify(token, otherKey, { audience: "authenticated" }),
    ).rejects.toThrow();
  });
});
