import { describe, it, expect } from "vitest";
import { shouldAttempt } from "$lib/server/catalog/chain";
import type {
  BookCatalogRowFields,
  FailReason,
} from "$lib/server/catalog/types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function descriptionRow(
  reason: FailReason | null,
  agedMs: number | null,
): Partial<BookCatalogRowFields> {
  return {
    description: null,
    description_attempted_at:
      agedMs === null ? null : new Date(Date.now() - agedMs).toISOString(),
    description_fail_reason: reason,
  };
}

describe("shouldAttempt", () => {
  const now = new Date();

  it("populated field never re-attempts", () => {
    expect(
      shouldAttempt(
        "description",
        {
          description: "filled",
          description_attempted_at: null,
          description_fail_reason: null,
        },
        now,
      ),
    ).toBe(false);
  });

  it("never-attempted unpopulated row always attempts", () => {
    expect(shouldAttempt("description", descriptionRow(null, null), now)).toBe(
      true,
    );
  });

  it("fail_reason null + attempted_at set means success — no re-attempt", () => {
    // A row whose value column is null AND fail_reason is null AND
    // attempted_at is set can only happen via direct DB manipulation (a
    // resolver-side success writes value and clears fail_reason; a
    // resolver-side failure writes fail_reason). Conservative: treat as
    // success — no re-attempt. Sync-loop avoidance.
    expect(
      shouldAttempt("description", descriptionRow(null, 5 * HOUR), now),
    ).toBe(false);
  });

  it("rate_limited respects 1h TTL", () => {
    expect(
      shouldAttempt(
        "description",
        descriptionRow("rate_limited", 30 * 60 * 1000),
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "description",
        descriptionRow("rate_limited", 2 * HOUR),
        now,
      ),
    ).toBe(true);
  });

  it("transient_error respects 1h TTL", () => {
    expect(
      shouldAttempt(
        "description",
        descriptionRow("transient_error", 30 * 60 * 1000),
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "description",
        descriptionRow("transient_error", 2 * HOUR),
        now,
      ),
    ).toBe(true);
  });

  it("provider_disabled respects 24h TTL", () => {
    expect(
      shouldAttempt(
        "description",
        descriptionRow("provider_disabled", 12 * HOUR),
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "description",
        descriptionRow("provider_disabled", 25 * HOUR),
        now,
      ),
    ).toBe(true);
  });

  it("provider_empty_field respects 30d TTL", () => {
    expect(
      shouldAttempt(
        "description",
        descriptionRow("provider_empty_field", 29 * DAY),
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "description",
        descriptionRow("provider_empty_field", 31 * DAY),
        now,
      ),
    ).toBe(true);
  });

  it("provider_no_data respects 90d TTL", () => {
    expect(
      shouldAttempt(
        "description",
        descriptionRow("provider_no_data", 89 * DAY),
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "description",
        descriptionRow("provider_no_data", 91 * DAY),
        now,
      ),
    ).toBe(true);
  });

  it("exhausted respects 90d TTL", () => {
    expect(
      shouldAttempt("description", descriptionRow("exhausted", 89 * DAY), now),
    ).toBe(false);
    expect(
      shouldAttempt("description", descriptionRow("exhausted", 91 * DAY), now),
    ).toBe(true);
  });

  it("cover uses storage_path as populated discriminant", () => {
    expect(
      shouldAttempt(
        "cover",
        {
          storage_path: "ab/abc.jpg",
          cover_storage_backend: "supabase",
          cover_attempted_at: null,
          cover_fail_reason: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "cover",
        {
          storage_path: null,
          cover_storage_backend: null,
          cover_attempted_at: null,
          cover_fail_reason: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it("subjects uses non-empty array as populated discriminant", () => {
    expect(
      shouldAttempt(
        "subjects",
        {
          subjects: ["fiction"],
          subjects_attempted_at: null,
          subjects_fail_reason: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "subjects",
        {
          subjects: [],
          subjects_attempted_at: null,
          subjects_fail_reason: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it("page_count uses non-null number as populated discriminant", () => {
    expect(
      shouldAttempt(
        "page_count",
        {
          page_count: 250,
          page_count_attempted_at: null,
          page_count_fail_reason: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      shouldAttempt(
        "page_count",
        {
          page_count: null,
          page_count_attempted_at: null,
          page_count_fail_reason: null,
        },
        now,
      ),
    ).toBe(true);
  });
});
