import { describe, it, expect } from "vitest";
import { stripMarketingCruft } from "../../../src/lib/server/catalog/cleanup";
import { MARKETING_CRUFT_FIXTURES } from "../../fixtures/marketing-cruft";

describe("stripMarketingCruft", () => {
  for (const { name, raw, cleaned } of MARKETING_CRUFT_FIXTURES) {
    it(`fixture: ${name}`, () => {
      expect(stripMarketingCruft(raw)).toBe(cleaned);
    });
  }

  it("returns input unchanged when empty", () => {
    expect(stripMarketingCruft("")).toBe("");
  });
});
