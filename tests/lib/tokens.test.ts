import { describe, it, expect } from "vitest";
import {
  generatePairingCode,
  generateDeviceToken,
  hashToken,
} from "$lib/server/tokens";

describe("generatePairingCode", () => {
  it("returns a 6-digit zero-padded string", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("generates different codes on successive calls", () => {
    const codes = new Set(
      Array.from({ length: 20 }, () => generatePairingCode()),
    );
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("generateDeviceToken", () => {
  it("returns a string prefixed with sk_device_", () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^sk_device_[A-Za-z0-9_-]+$/);
  });

  it("generates at least 32 characters of randomness after prefix", () => {
    const token = generateDeviceToken();
    const random = token.replace("sk_device_", "");
    expect(random.length).toBeGreaterThanOrEqual(32);
  });
});

describe("hashToken", () => {
  it("produces a bcrypt hash that does not match the plaintext", async () => {
    const token = "sk_device_test123";
    const hash = await hashToken(token);
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^\$2[aby]\$/);
  });
});
