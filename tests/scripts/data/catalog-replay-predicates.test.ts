import { describe, it, expect } from "vitest";
import {
  isTrackedField,
  isFailReason,
  missingFieldColumn,
  failReasonOrClause,
  parseFieldsArg,
  pickPredicateMode,
  TRACKED_FIELDS,
  FAIL_REASONS,
} from "../../../scripts/data/catalog-replay-predicates";

describe("isTrackedField", () => {
  it("accepts every TRACKED_FIELDS literal", () => {
    for (const f of TRACKED_FIELDS) {
      expect(isTrackedField(f)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isTrackedField("bogus")).toBe(false);
    expect(isTrackedField("")).toBe(false);
    expect(isTrackedField("COVER")).toBe(false); // case-sensitive
  });
});

describe("isFailReason", () => {
  it("accepts every FAIL_REASONS literal", () => {
    for (const r of FAIL_REASONS) {
      expect(isFailReason(r)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isFailReason("ratelimit")).toBe(false);
    expect(isFailReason("")).toBe(false);
  });
});

describe("missingFieldColumn", () => {
  it("maps cover to storage_path", () => {
    expect(missingFieldColumn("cover")).toBe("storage_path");
  });

  it("returns the field name itself for the other five", () => {
    expect(missingFieldColumn("description")).toBe("description");
    expect(missingFieldColumn("publisher")).toBe("publisher");
    expect(missingFieldColumn("published_date")).toBe("published_date");
    expect(missingFieldColumn("subjects")).toBe("subjects");
    expect(missingFieldColumn("page_count")).toBe("page_count");
  });
});

describe("failReasonOrClause", () => {
  it("emits comma-separated <field>_fail_reason.eq.<reason> for every tracked field", () => {
    const clause = failReasonOrClause("rate_limited");
    expect(clause).toBe(
      "cover_fail_reason.eq.rate_limited," +
        "description_fail_reason.eq.rate_limited," +
        "publisher_fail_reason.eq.rate_limited," +
        "published_date_fail_reason.eq.rate_limited," +
        "subjects_fail_reason.eq.rate_limited," +
        "page_count_fail_reason.eq.rate_limited",
    );
  });

  it("no leading/trailing whitespace (would break PostgREST parse)", () => {
    const clause = failReasonOrClause("exhausted");
    expect(clause).not.toMatch(/^\s|\s$/);
  });

  it("clause length matches TRACKED_FIELDS count", () => {
    const clause = failReasonOrClause("transient_error");
    expect(clause.split(",")).toHaveLength(TRACKED_FIELDS.length);
  });
});

describe("parseFieldsArg", () => {
  it("parses single field", () => {
    expect(parseFieldsArg("description")).toEqual(["description"]);
  });

  it("parses comma-separated list", () => {
    expect(parseFieldsArg("description,cover")).toEqual([
      "description",
      "cover",
    ]);
  });

  it("trims whitespace around tokens", () => {
    expect(parseFieldsArg(" description , cover ")).toEqual([
      "description",
      "cover",
    ]);
  });

  it("throws on unknown field with valid-list message", () => {
    expect(() => parseFieldsArg("description,bogus")).toThrow(
      /Unknown field "bogus"/,
    );
  });
});

describe("pickPredicateMode", () => {
  it("returns isbns mode with trimmed list", () => {
    const mode = pickPredicateMode({ isbns: "9780000000001, 9780000000002 ," });
    expect(mode).toEqual({
      kind: "isbns",
      isbns: ["9780000000001", "9780000000002"],
    });
  });

  it("returns missing mode for valid field", () => {
    expect(pickPredicateMode({ missing: "description" })).toEqual({
      kind: "missing",
      field: "description",
    });
  });

  it("returns by-fail-reason mode for valid reason", () => {
    expect(pickPredicateMode({ byFailReason: "rate_limited" })).toEqual({
      kind: "by-fail-reason",
      reason: "rate_limited",
    });
  });

  it("throws when no mode supplied", () => {
    expect(() => pickPredicateMode({})).toThrow(/Pass one of --isbns/);
  });

  it("throws when two modes supplied (mutual exclusivity)", () => {
    expect(() =>
      pickPredicateMode({ isbns: "9780000000001", missing: "description" }),
    ).toThrow(/exactly one predicate mode; got --isbns and --missing/);
  });

  it("throws when all three modes supplied", () => {
    expect(() =>
      pickPredicateMode({
        isbns: "9780000000001",
        missing: "description",
        byFailReason: "rate_limited",
      }),
    ).toThrow(/exactly one predicate mode/);
  });

  it("rejects unknown --missing field with valid-list message", () => {
    expect(() => pickPredicateMode({ missing: "bogus" })).toThrow(
      /--missing must be one of/,
    );
  });

  it("rejects unknown --by-fail-reason value with valid-list message", () => {
    expect(() => pickPredicateMode({ byFailReason: "bogus" })).toThrow(
      /--by-fail-reason must be one of/,
    );
  });
});
