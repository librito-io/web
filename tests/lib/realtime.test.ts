import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import {
  mintRealtimeToken,
  REALTIME_TOKEN_TTL_SECONDS,
} from "$lib/server/realtime";

const SECRET = "test-jwt-secret-at-least-32-bytes-long-padding";

describe("mintRealtimeToken", () => {
  it("returns expiresIn of exactly 86400 seconds", async () => {
    const { expiresIn } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      jwtSecret: SECRET,
    });
    expect(expiresIn).toBe(86400);
    expect(REALTIME_TOKEN_TTL_SECONDS).toBe(86400);
  });

  it("signs an HS256 JWT with sub, role, aud, exp, iat, device_id claims", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const deviceId = "22222222-2222-2222-2222-222222222222";
    const before = Math.floor(Date.now() / 1000);
    const { token } = await mintRealtimeToken({
      userId,
      deviceId,
      jwtSecret: SECRET,
    });
    const after = Math.floor(Date.now() / 1000);

    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
      { audience: "authenticated" },
    );

    expect(protectedHeader.alg).toBe("HS256");
    expect(protectedHeader.typ).toBe("JWT");
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

  it("rejects verification with the wrong secret", async () => {
    const { token } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      jwtSecret: SECRET,
    });
    await expect(
      jwtVerify(
        token,
        new TextEncoder().encode("wrong-secret-padding-padding-padding"),
        {
          audience: "authenticated",
        },
      ),
    ).rejects.toThrow();
  });
});
