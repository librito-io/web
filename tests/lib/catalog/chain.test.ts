import { describe, it, expect } from "vitest";
import { walkChain, type LegOutcome } from "$lib/server/catalog/chain";
import type { ResolveCtx } from "$lib/server/catalog/types";

const ctx: ResolveCtx = {};

describe("walkChain", () => {
  it("returns first success with provider, fail_reason null", async () => {
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => ({
            kind: "success",
            value: "ol text",
            provider: "openlibrary",
          }),
          async () => {
            throw new Error("should not reach second leg");
          },
        ],
      },
      ctx,
    );
    expect(result).toEqual({
      value: "ol text",
      provider: "openlibrary",
      fail_reason: null,
    });
  });

  it("aggregates all-no_data into provider_no_data", async () => {
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () =>
            ({
              kind: "no_data",
              provider: "openlibrary",
            }) as LegOutcome<string>,
          async () =>
            ({
              kind: "no_data",
              provider: "google_books",
            }) as LegOutcome<string>,
        ],
      },
      ctx,
    );
    expect(result).toEqual({
      value: null,
      provider: null,
      fail_reason: "provider_no_data",
    });
  });

  it("any rate_limited (no success) wins over disabled/empty/no_data", async () => {
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => ({ kind: "rate_limited" }) as LegOutcome<string>,
          async () =>
            ({
              kind: "no_data",
              provider: "google_books",
            }) as LegOutcome<string>,
          async () =>
            ({ kind: "empty", provider: "itunes" }) as LegOutcome<string>,
        ],
      },
      ctx,
    );
    expect(result.fail_reason).toBe("rate_limited");
  });

  it("any transient wins (when no rate_limited present)", async () => {
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () =>
            ({
              kind: "transient",
              error: new Error("5xx"),
            }) as LegOutcome<string>,
          async () =>
            ({
              kind: "no_data",
              provider: "google_books",
            }) as LegOutcome<string>,
        ],
      },
      ctx,
    );
    expect(result.fail_reason).toBe("transient_error");
  });

  it("all-disabled aggregates to provider_disabled", async () => {
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => ({ kind: "disabled" }) as LegOutcome<string>,
          async () => ({ kind: "disabled" }) as LegOutcome<string>,
        ],
      },
      ctx,
    );
    expect(result.fail_reason).toBe("provider_disabled");
  });

  it("any empty (item exists, field blank) aggregates to provider_empty_field", async () => {
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () =>
            ({
              kind: "no_data",
              provider: "openlibrary",
            }) as LegOutcome<string>,
          async () =>
            ({ kind: "empty", provider: "google_books" }) as LegOutcome<string>,
        ],
      },
      ctx,
    );
    expect(result.fail_reason).toBe("provider_empty_field");
  });

  it("empty wins over no_data in mixed-without-other-reasons case", async () => {
    // Spec walker priority: rate_limited > transient > all-disabled > any-empty
    // > all-no_data > exhausted. So empty + no_data resolves to
    // provider_empty_field, not exhausted (the spec's "mixed empty/no_data
    // → exhausted" line is unreachable under the any-empty branch).
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () =>
            ({ kind: "empty", provider: "openlibrary" }) as LegOutcome<string>,
          async () =>
            ({
              kind: "no_data",
              provider: "google_books",
            }) as LegOutcome<string>,
        ],
      },
      ctx,
    );
    expect(result.fail_reason).toBe("provider_empty_field");
  });

  it("disabled + no_data (no other reasons) aggregates to exhausted", async () => {
    // Not all-disabled, not any-empty, not all-no_data. Falls through.
    const result = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => ({ kind: "disabled" }) as LegOutcome<string>,
          async () =>
            ({
              kind: "no_data",
              provider: "openlibrary",
            }) as LegOutcome<string>,
        ],
      },
      ctx,
    );
    expect(result.fail_reason).toBe("exhausted");
  });

  it("zero legs returns exhausted (skip-and-retry-next-pass posture)", async () => {
    const result = await walkChain<string>(
      { field: "description", legs: [] },
      ctx,
    );
    expect(result).toEqual({
      value: null,
      provider: null,
      fail_reason: "exhausted",
    });
  });
});
