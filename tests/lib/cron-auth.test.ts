// tests/lib/cron-auth.test.ts
import { describe, it, expect } from "vitest";
import {
  authorizeCronRequest,
  constantTimeEqualString,
} from "../../src/lib/server/cron-auth";

describe("constantTimeEqualString", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqualString("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqualString("hello", "world")).toBe(false);
  });

  it("returns false for different lengths (no length leak via short-circuit)", () => {
    // Both inputs are SHA-256 hashed to fixed 32-byte buffers before
    // timingSafeEqual; the comparison itself never observes the original
    // length, so this asserts behavior, not timing.
    expect(constantTimeEqualString("short", "longer-string")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqualString("", "")).toBe(true);
  });

  it("returns true for long equal secrets (64 chars)", () => {
    const long = "a".repeat(64);
    expect(constantTimeEqualString(long, long)).toBe(true);
  });

  it("returns false when long secret differs by one char", () => {
    const a = "a".repeat(63) + "b";
    const b = "a".repeat(63) + "c";
    expect(constantTimeEqualString(a, b)).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(constantTimeEqualString("", "nonempty")).toBe(false);
  });
});

describe("authorizeCronRequest", () => {
  const secret = "sk_cron_test_secret_long_enough_to_be_realistic";

  function reqWith(authHeader?: string): Request {
    const headers = new Headers();
    if (authHeader !== undefined) headers.set("authorization", authHeader);
    return new Request("https://example.test/api/cron/x", { headers });
  }

  it("returns 500 server_misconfigured when secret is undefined", async () => {
    const res = authorizeCronRequest(reqWith(`Bearer ${secret}`), undefined);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({
      error: "server_misconfigured",
      message: "CRON_SECRET unset",
    });
  });

  it("returns 500 server_misconfigured when secret is empty string", async () => {
    const res = authorizeCronRequest(reqWith(`Bearer ${secret}`), "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
  });

  it("returns 401 unauthorized when Authorization header missing", async () => {
    const res = authorizeCronRequest(reqWith(), secret);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({
      error: "unauthorized",
      message: "Cron secret mismatch",
    });
  });

  it("returns 401 unauthorized when Bearer token mismatches", async () => {
    const res = authorizeCronRequest(reqWith("Bearer wrong"), secret);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns 401 unauthorized when Authorization scheme is not Bearer", async () => {
    const res = authorizeCronRequest(reqWith(`Basic ${secret}`), secret);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns null when Bearer token matches", () => {
    const res = authorizeCronRequest(reqWith(`Bearer ${secret}`), secret);
    expect(res).toBeNull();
  });
});
