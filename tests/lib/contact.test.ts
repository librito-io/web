import { describe, it, expect } from "vitest";
import { validateContactInput } from "$lib/server/contact";

describe("validateContactInput", () => {
  it("accepts a valid email + message and trims them", () => {
    const r = validateContactInput({
      email: "  User@Example.com ",
      message: "  Hi there  ",
    });
    expect(r).toEqual({
      ok: true,
      email: "user@example.com",
      message: "Hi there",
    });
  });

  it("rejects a missing/invalid email", () => {
    expect(validateContactInput({ email: "nope", message: "hi" }).ok).toBe(
      false,
    );
    expect(validateContactInput({ email: 123, message: "hi" }).ok).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(validateContactInput({ email: "a@b.co", message: "   " }).ok).toBe(
      false,
    );
    expect(validateContactInput({ email: "a@b.co", message: 5 }).ok).toBe(
      false,
    );
  });

  it("rejects an over-long message", () => {
    const long = "x".repeat(5001);
    expect(validateContactInput({ email: "a@b.co", message: long }).ok).toBe(
      false,
    );
  });
});
