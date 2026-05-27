import { describe, expect, it } from "vitest";
import { walkChain, type LegOutcome } from "$lib/server/catalog/chain";
import {
  classifyDescriptionFromGoogleBooks,
  classifyDescriptionFromItunes,
  classifyDescriptionFromOpenLibrary,
  classifyPublisherFromGoogleBooks,
  classifyPublisherFromOpenLibrary,
} from "$lib/server/catalog/field-legs";

describe("end-to-end leg → walker fail-reason classifications", () => {
  it("OL no_data + GB rate-limited + no iTunes → rate_limited", async () => {
    const r = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => classifyDescriptionFromOpenLibrary(null),
          async () =>
            classifyDescriptionFromGoogleBooks({
              apiKeySet: true,
              outcome: { kind: "rate_limited" },
            }),
        ],
      },
      {},
    );
    expect(r.fail_reason).toBe("rate_limited");
  });

  it("OL empty + GB empty → provider_empty_field", async () => {
    const r = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => classifyDescriptionFromOpenLibrary({ subjects: ["x"] }),
          async () =>
            classifyDescriptionFromGoogleBooks({
              apiKeySet: true,
              outcome: {
                kind: "ok",
                value: { id: "v1", volumeInfo: { title: "T" } },
              },
            }),
        ],
      },
      {},
    );
    expect(r.fail_reason).toBe("provider_empty_field");
  });

  it("OL transient + GB no_data → transient_error", async () => {
    const r = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () =>
            ({
              kind: "transient",
              error: new Error("net"),
            }) as LegOutcome<string>,
          async () =>
            classifyDescriptionFromGoogleBooks({
              apiKeySet: true,
              outcome: { kind: "empty" },
            }),
        ],
      },
      {},
    );
    expect(r.fail_reason).toBe("transient_error");
  });

  it("only GB disabled (api key unset) → provider_disabled", async () => {
    const r = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => classifyDescriptionFromGoogleBooks({ apiKeySet: false }),
        ],
      },
      {},
    );
    expect(r.fail_reason).toBe("provider_disabled");
  });

  it("OL no_data + GB disabled (mixed) → exhausted (no any-empty branch)", async () => {
    // Walker priority: not all-disabled (OL was no_data), not any-empty,
    // not all-no_data (one disabled). Falls through to exhausted.
    const r = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => classifyDescriptionFromOpenLibrary(null),
          async () => classifyDescriptionFromGoogleBooks({ apiKeySet: false }),
        ],
      },
      {},
    );
    expect(r.fail_reason).toBe("exhausted");
  });

  it("OL success short-circuits + no GB call observed", async () => {
    let gbCalled = false;
    const r = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () =>
            classifyDescriptionFromOpenLibrary({
              description: "from openlibrary",
            }),
          async () => {
            gbCalled = true;
            return classifyDescriptionFromGoogleBooks({
              apiKeySet: true,
              outcome: { kind: "rate_limited" },
            });
          },
        ],
      },
      {},
    );
    expect(r.value).toBe("from openlibrary");
    expect(r.provider).toBe("openlibrary");
    expect(r.fail_reason).toBeNull();
    expect(gbCalled).toBe(false);
  });

  it("publisher chain: GB success after OL empty → google_books provider", async () => {
    const r = await walkChain<string>(
      {
        field: "publisher",
        legs: [
          async () => classifyPublisherFromOpenLibrary({ publishers: [{}] }),
          async () =>
            classifyPublisherFromGoogleBooks({
              apiKeySet: true,
              outcome: {
                kind: "ok",
                value: {
                  id: "v1",
                  volumeInfo: { publisher: "Penguin" },
                },
              },
            }),
        ],
      },
      {},
    );
    expect(r).toEqual({
      value: "Penguin",
      provider: "google_books",
      fail_reason: null,
    });
  });

  it("description chain with iTunes leg disabled (TA path): OL no_data + GB no_data + iTunes disabled → exhausted", async () => {
    const r = await walkChain<string>(
      {
        field: "description",
        legs: [
          async () => classifyDescriptionFromOpenLibrary(null),
          async () =>
            classifyDescriptionFromGoogleBooks({
              apiKeySet: true,
              outcome: { kind: "empty" },
            }),
          async () => classifyDescriptionFromItunes({ hasIsbn: false }),
        ],
      },
      {},
    );
    expect(r.fail_reason).toBe("exhausted");
  });
});
