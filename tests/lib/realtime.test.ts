import { describe, it, expect, beforeAll } from "vitest";
import { jwtVerify, generateKeyPair, exportPKCS8, exportJWK } from "jose";
import type { CryptoKey, JWK } from "jose";
import {
  mintRealtimeToken,
  REALTIME_TOKEN_TTL_SECONDS,
} from "$lib/server/realtime";

const ISSUER = "https://test.librito.io";
const KID = "test-kid-uuid";

let privateKeyPem: string;
let publicKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privateKeyPem = await exportPKCS8(kp.privateKey);
  publicKey = kp.publicKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = KID;
  publicJwk.use = "sig";
  publicJwk.alg = "ES256";
});

describe("mintRealtimeToken", () => {
  it("returns expiresIn of exactly 86400 seconds", async () => {
    const { expiresIn } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateKeyPem,
      kid: KID,
      issuer: ISSUER,
    });
    expect(expiresIn).toBe(86400);
    expect(REALTIME_TOKEN_TTL_SECONDS).toBe(86400);
  });

  it("signs an ES256 JWT with kid header, iss/sub/role/aud/exp/iat/device_id claims", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const deviceId = "22222222-2222-2222-2222-222222222222";
    const before = Math.floor(Date.now() / 1000);
    const { token } = await mintRealtimeToken({
      userId,
      deviceId,
      privateKeyPem,
      kid: KID,
      issuer: ISSUER,
    });
    const after = Math.floor(Date.now() / 1000);

    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      audience: "authenticated",
      issuer: ISSUER,
    });

    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.typ).toBe("JWT");
    expect(protectedHeader.kid).toBe(KID);
    expect(payload.iss).toBe(ISSUER);
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

  it("throws when privateKeyPem is missing the PKCS8 BEGIN header", async () => {
    await expect(
      mintRealtimeToken({
        userId: "11111111-1111-1111-1111-111111111111",
        deviceId: "22222222-2222-2222-2222-222222222222",
        privateKeyPem: "not-a-pem-blob",
        kid: KID,
        issuer: ISSUER,
      }),
    ).rejects.toThrow(/PKCS8 PEM/);
  });

  it("rejects verification with a different keypair", async () => {
    const { token } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateKeyPem,
      kid: KID,
      issuer: ISSUER,
    });
    const otherKp = await generateKeyPair("ES256", { extractable: true });
    await expect(
      jwtVerify(token, otherKp.publicKey, {
        audience: "authenticated",
        issuer: ISSUER,
      }),
    ).rejects.toThrow();
  });
});
