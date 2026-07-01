import { describe, it, expect } from "vitest";
import { createMockSupabase } from "../helpers";
import {
  normalizeEmail,
  isValidEmail,
  processNewsletterSignup,
} from "$lib/server/newsletter";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("isValidEmail", () => {
  it("accepts a normal address", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
  });
  it("rejects malformed input", () => {
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("processNewsletterSignup", () => {
  it("returns fresh=true when a row is inserted", async () => {
    const mock = createMockSupabase();
    mock._results.set("newsletter_signups.upsert", {
      data: [{ id: "new-id" }],
      error: null,
    });
    const res = await processNewsletterSignup(
      mock as never,
      "  New@Example.com ",
      "en",
    );
    expect(res.fresh).toBe(true);
  });

  it("returns fresh=false when the email already exists (conflict ignored)", async () => {
    const mock = createMockSupabase();
    mock._results.set("newsletter_signups.upsert", { data: [], error: null });
    const res = await processNewsletterSignup(
      mock as never,
      "dup@example.com",
      null,
    );
    expect(res.fresh).toBe(false);
  });

  it("throws on a DB error", async () => {
    const mock = createMockSupabase();
    mock._results.set("newsletter_signups.upsert", {
      data: null,
      error: { message: "boom" },
    });
    await expect(
      processNewsletterSignup(mock as never, "x@example.com", null),
    ).rejects.toThrow();
  });
});
