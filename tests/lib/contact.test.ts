import { describe, it, expect } from "vitest";
import { validateContactInput } from "$lib/server/contact";

describe("validateContactInput", () => {
  it("accepts a valid name + email + message and trims them", () => {
    const r = validateContactInput({
      name: "  Ada Lovelace ",
      email: "  User@Example.com ",
      message: "  Hi there  ",
      reason: "bug",
    });
    expect(r).toEqual({
      ok: true,
      name: "Ada Lovelace",
      email: "user@example.com",
      message: "Hi there",
      reason: "bug",
    });
  });

  it("passes known reasons through and coerces unknown/missing to 'other'", () => {
    const base = { name: "Ada", email: "a@b.co", message: "hi" };
    for (const reason of ["bug", "feature", "other"] as const) {
      const r = validateContactInput({ ...base, reason });
      expect(r.ok && r.reason).toBe(reason);
    }
    // Unknown string, wrong type, and omitted all fall back to "other".
    expect(
      (validateContactInput({ ...base, reason: "spam" }) as { reason: string })
        .reason,
    ).toBe("other");
    expect(
      (validateContactInput({ ...base, reason: 7 }) as { reason: string })
        .reason,
    ).toBe("other");
    expect((validateContactInput(base) as { reason: string }).reason).toBe(
      "other",
    );
  });

  it("rejects a missing/blank name", () => {
    expect(
      validateContactInput({ name: "   ", email: "a@b.co", message: "hi" }).ok,
    ).toBe(false);
    expect(
      validateContactInput({ name: 5, email: "a@b.co", message: "hi" }).ok,
    ).toBe(false);
  });

  it("rejects an over-long name", () => {
    const long = "x".repeat(201);
    expect(
      validateContactInput({ name: long, email: "a@b.co", message: "hi" }).ok,
    ).toBe(false);
  });

  it("rejects a missing/invalid email", () => {
    expect(
      validateContactInput({ name: "Ada", email: "nope", message: "hi" }).ok,
    ).toBe(false);
    expect(
      validateContactInput({ name: "Ada", email: 123, message: "hi" }).ok,
    ).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(
      validateContactInput({ name: "Ada", email: "a@b.co", message: "   " }).ok,
    ).toBe(false);
    expect(
      validateContactInput({ name: "Ada", email: "a@b.co", message: 5 }).ok,
    ).toBe(false);
  });

  it("rejects an over-long message", () => {
    const long = "x".repeat(5001);
    expect(
      validateContactInput({ name: "Ada", email: "a@b.co", message: long }).ok,
    ).toBe(false);
  });
});
