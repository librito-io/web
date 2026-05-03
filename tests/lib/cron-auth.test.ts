// tests/lib/cron-auth.test.ts
import { describe, it, expect } from "vitest";
import { constantTimeEqualString } from "../../src/lib/server/cron-auth";

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
