import { describe, it, expect } from "vitest";
import {
  classifyDescriptionFromOpenLibrary,
  classifyDescriptionFromGoogleBooks,
  classifyDescriptionFromItunes,
  classifyPublisherFromOpenLibrary,
  classifyPublisherFromGoogleBooks,
  classifyPublishedDateFromOpenLibrary,
  classifyPublishedDateFromGoogleBooks,
  classifyPageCountFromOpenLibrary,
  classifyPageCountFromGoogleBooks,
  classifySubjectsFromOpenLibrary,
  classifySubjectsFromGoogleBooks,
} from "$lib/server/catalog/field-legs";

describe("classifyDescriptionFromOpenLibrary", () => {
  it("returns success when work.description is a non-empty string", () => {
    expect(
      classifyDescriptionFromOpenLibrary({ description: "A novel about..." }),
    ).toEqual({
      kind: "success",
      value: "A novel about...",
      provider: "openlibrary",
    });
  });

  it("unwraps OL {value: ...} object shape", () => {
    expect(
      classifyDescriptionFromOpenLibrary({ description: { value: "Nested" } }),
    ).toEqual({ kind: "success", value: "Nested", provider: "openlibrary" });
  });

  it("returns no_data when olWork is null (work fetch failed/missing)", () => {
    expect(classifyDescriptionFromOpenLibrary(null)).toEqual({
      kind: "no_data",
      provider: "openlibrary",
    });
  });

  it("returns empty when olWork present but no description field", () => {
    expect(
      classifyDescriptionFromOpenLibrary({ subjects: ["fiction"] }),
    ).toEqual({ kind: "empty", provider: "openlibrary" });
  });

  it("treats blank-string description as empty, not success", () => {
    expect(classifyDescriptionFromOpenLibrary({ description: "" })).toEqual({
      kind: "empty",
      provider: "openlibrary",
    });
  });

  it("trims leading/trailing whitespace from string description", () => {
    expect(
      classifyDescriptionFromOpenLibrary({
        description: "  A novel about...\n\n",
      }),
    ).toEqual({
      kind: "success",
      value: "A novel about...",
      provider: "openlibrary",
    });
  });

  it("trims OL {value: ...} object description", () => {
    expect(
      classifyDescriptionFromOpenLibrary({
        description: { value: "\n\tNested with whitespace\n" },
      }),
    ).toEqual({
      kind: "success",
      value: "Nested with whitespace",
      provider: "openlibrary",
    });
  });

  it("whitespace-only description folds into empty", () => {
    expect(
      classifyDescriptionFromOpenLibrary({ description: "   \n\t  " }),
    ).toEqual({ kind: "empty", provider: "openlibrary" });
  });
});

describe("classifyDescriptionFromGoogleBooks", () => {
  it("disabled when apiKey missing", () => {
    expect(classifyDescriptionFromGoogleBooks({ apiKeySet: false })).toEqual({
      kind: "disabled",
    });
  });

  it("rate_limited when fetch outcome is rate_limited", () => {
    expect(
      classifyDescriptionFromGoogleBooks({
        apiKeySet: true,
        outcome: { kind: "rate_limited" },
      }),
    ).toEqual({ kind: "rate_limited" });
  });

  it("transient when fetch outcome is transient", () => {
    expect(
      classifyDescriptionFromGoogleBooks({
        apiKeySet: true,
        outcome: { kind: "transient", error: new Error("5xx") },
      }),
    ).toEqual({ kind: "transient", error: expect.any(Error) });
  });

  it("no_data when fetch outcome is empty (200, no matching volume)", () => {
    expect(
      classifyDescriptionFromGoogleBooks({
        apiKeySet: true,
        outcome: { kind: "empty" },
      }),
    ).toEqual({ kind: "no_data", provider: "google_books" });
  });

  it("empty when volume found but description blank", () => {
    expect(
      classifyDescriptionFromGoogleBooks({
        apiKeySet: true,
        outcome: {
          kind: "ok",
          value: { id: "v1", volumeInfo: { title: "T" } },
        },
      }),
    ).toEqual({ kind: "empty", provider: "google_books" });
  });

  it("success returns sanitized description + provider", () => {
    const result = classifyDescriptionFromGoogleBooks({
      apiKeySet: true,
      outcome: {
        kind: "ok",
        value: {
          id: "v1",
          volumeInfo: { description: "<p>A book.</p>" },
        },
      },
    });
    expect(result).toMatchObject({ kind: "success", provider: "google_books" });
  });
});

describe("classifyDescriptionFromItunes", () => {
  it("disabled when no ISBN (TA path)", () => {
    expect(classifyDescriptionFromItunes({ hasIsbn: false })).toEqual({
      kind: "disabled",
    });
  });

  it("rate_limited when outcome is rate_limited", () => {
    expect(
      classifyDescriptionFromItunes({
        hasIsbn: true,
        outcome: { kind: "rate_limited" },
      }),
    ).toEqual({ kind: "rate_limited" });
  });

  it("transient when outcome is transient", () => {
    expect(
      classifyDescriptionFromItunes({
        hasIsbn: true,
        outcome: { kind: "transient", error: new Error("net") },
      }),
    ).toEqual({ kind: "transient", error: expect.any(Error) });
  });

  it("no_data when 200 with no matching item", () => {
    expect(
      classifyDescriptionFromItunes({
        hasIsbn: true,
        outcome: { kind: "empty" },
      }),
    ).toEqual({ kind: "no_data", provider: "itunes" });
  });

  it("empty when item found but no description", () => {
    expect(
      classifyDescriptionFromItunes({
        hasIsbn: true,
        outcome: { kind: "ok", value: { trackName: "Book" } },
      }),
    ).toEqual({ kind: "empty", provider: "itunes" });
  });

  it("success when item has description", () => {
    expect(
      classifyDescriptionFromItunes({
        hasIsbn: true,
        outcome: { kind: "ok", value: { description: "From iTunes." } },
      }),
    ).toEqual({ kind: "success", value: "From iTunes.", provider: "itunes" });
  });
});

describe("classifyPublisherFromOpenLibrary", () => {
  it("success from publishers[0].name", () => {
    expect(
      classifyPublisherFromOpenLibrary({
        publishers: [{ name: "Penguin" }],
      }),
    ).toEqual({ kind: "success", value: "Penguin", provider: "openlibrary" });
  });

  it("joins multi-publisher names with ', '", () => {
    expect(
      classifyPublisherFromOpenLibrary({
        publishers: [{ name: "Penguin" }, { name: "Random House" }],
      }),
    ).toEqual({
      kind: "success",
      value: "Penguin, Random House",
      provider: "openlibrary",
    });
  });

  it("filters blank entries from multi-publisher set", () => {
    expect(
      classifyPublisherFromOpenLibrary({
        publishers: [{ name: "Penguin" }, {}, { name: "Random House" }],
      }),
    ).toEqual({
      kind: "success",
      value: "Penguin, Random House",
      provider: "openlibrary",
    });
  });

  it("no_data when olData is null", () => {
    expect(classifyPublisherFromOpenLibrary(null)).toEqual({
      kind: "no_data",
      provider: "openlibrary",
    });
  });

  it("empty when publishers missing or every entry blank", () => {
    expect(classifyPublisherFromOpenLibrary({})).toEqual({
      kind: "empty",
      provider: "openlibrary",
    });
    expect(classifyPublisherFromOpenLibrary({ publishers: [{}] })).toEqual({
      kind: "empty",
      provider: "openlibrary",
    });
  });
});

describe("classifyPublisherFromGoogleBooks", () => {
  it("success from volumeInfo.publisher", () => {
    expect(
      classifyPublisherFromGoogleBooks({
        apiKeySet: true,
        outcome: {
          kind: "ok",
          value: { id: "v1", volumeInfo: { publisher: "Penguin" } },
        },
      }),
    ).toEqual({ kind: "success", value: "Penguin", provider: "google_books" });
  });

  it("disabled when apiKey unset", () => {
    expect(classifyPublisherFromGoogleBooks({ apiKeySet: false })).toEqual({
      kind: "disabled",
    });
  });
});

describe("classifyPublishedDateFromOpenLibrary", () => {
  it("success from publish_date", () => {
    expect(
      classifyPublishedDateFromOpenLibrary({ publish_date: "2020" }),
    ).toEqual({ kind: "success", value: "2020", provider: "openlibrary" });
  });

  it("empty when publish_date missing", () => {
    expect(classifyPublishedDateFromOpenLibrary({})).toEqual({
      kind: "empty",
      provider: "openlibrary",
    });
  });
});

describe("classifyPublishedDateFromGoogleBooks", () => {
  it("success from volumeInfo.publishedDate", () => {
    expect(
      classifyPublishedDateFromGoogleBooks({
        apiKeySet: true,
        outcome: {
          kind: "ok",
          value: { id: "v1", volumeInfo: { publishedDate: "2020-01-01" } },
        },
      }),
    ).toEqual({
      kind: "success",
      value: "2020-01-01",
      provider: "google_books",
    });
  });
});

describe("classifyPageCountFromOpenLibrary", () => {
  it("success from number_of_pages", () => {
    expect(classifyPageCountFromOpenLibrary({ number_of_pages: 250 })).toEqual({
      kind: "success",
      value: 250,
      provider: "openlibrary",
    });
  });

  it("empty when page count missing or zero", () => {
    expect(classifyPageCountFromOpenLibrary({})).toEqual({
      kind: "empty",
      provider: "openlibrary",
    });
    expect(classifyPageCountFromOpenLibrary({ number_of_pages: 0 })).toEqual({
      kind: "empty",
      provider: "openlibrary",
    });
  });
});

describe("classifyPageCountFromGoogleBooks", () => {
  it("success from volumeInfo.pageCount", () => {
    expect(
      classifyPageCountFromGoogleBooks({
        apiKeySet: true,
        outcome: {
          kind: "ok",
          value: { id: "v1", volumeInfo: { pageCount: 300 } },
        },
      }),
    ).toEqual({ kind: "success", value: 300, provider: "google_books" });
  });
});

describe("classifySubjectsFromOpenLibrary", () => {
  it("merges data.subjects + work.subjects, dedupes", () => {
    expect(
      classifySubjectsFromOpenLibrary(
        { subjects: ["fiction", { name: "novels" }] },
        { subjects: ["fiction", "literature"] },
      ),
    ).toEqual({
      kind: "success",
      value: ["fiction", "novels", "literature"],
      provider: "openlibrary",
    });
  });

  it("no_data when both olData and olWork null", () => {
    expect(classifySubjectsFromOpenLibrary(null, null)).toEqual({
      kind: "no_data",
      provider: "openlibrary",
    });
  });

  it("empty when both present but yield zero subjects", () => {
    expect(classifySubjectsFromOpenLibrary({}, {})).toEqual({
      kind: "empty",
      provider: "openlibrary",
    });
  });

  it("caps merged subjects at 30 entries (matches pre-refit extract.ts)", () => {
    const fromData = Array.from({ length: 25 }).map(
      (_, i) => `data-subject-${i}`,
    );
    const fromWork = Array.from({ length: 25 }).map(
      (_, i) => `work-subject-${i}`,
    );
    const r = classifySubjectsFromOpenLibrary(
      { subjects: fromData },
      { subjects: fromWork },
    );
    expect(r.kind).toBe("success");
    expect((r as { value: string[] }).value).toHaveLength(30);
  });
});

describe("classifySubjectsFromGoogleBooks", () => {
  it("success from volumeInfo.categories", () => {
    expect(
      classifySubjectsFromGoogleBooks({
        apiKeySet: true,
        outcome: {
          kind: "ok",
          value: {
            id: "v1",
            volumeInfo: { categories: ["Fiction / Literary"] },
          },
        },
      }),
    ).toEqual({
      kind: "success",
      value: ["Fiction / Literary"],
      provider: "google_books",
    });
  });

  it("empty when categories empty array", () => {
    expect(
      classifySubjectsFromGoogleBooks({
        apiKeySet: true,
        outcome: {
          kind: "ok",
          value: { id: "v1", volumeInfo: { categories: [] } },
        },
      }),
    ).toEqual({ kind: "empty", provider: "google_books" });
  });
});
