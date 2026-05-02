import { describe, it, expect } from "vitest";
import {
  extractOpenLibraryMetadata,
  extractGoogleBooksMetadata,
} from "../../../src/lib/server/catalog/extract";
import type { GoogleBooksItem } from "../../../src/lib/server/catalog/types";
import gatsbyOL from "../../fixtures/openlibrary/great-gatsby.json";
import gatsbyOLWork from "../../fixtures/openlibrary/great-gatsby-work.json";
import gatsbyGB from "../../fixtures/googlebooks/great-gatsby.json";

describe("extractOpenLibraryMetadata", () => {
  it("pulls title, author, publisher, page count, subjects from canonical shape", () => {
    const meta = extractOpenLibraryMetadata(gatsbyOL, gatsbyOLWork);
    expect(meta.title).toMatch(/Gatsby/);
    expect(meta.author).toMatch(/Fitzgerald/);
    expect(meta.publisher).toBeTruthy();
    expect(meta.page_count).toBeGreaterThan(0);
    expect(Array.isArray(meta.subjects)).toBe(true);
    expect(meta.description_provider).toBe("openlibrary");
  });

  it("returns empty metadata on null input", () => {
    expect(extractOpenLibraryMetadata(null, null)).toEqual({});
  });
});

describe("extractGoogleBooksMetadata", () => {
  it("pulls description and language from volumeInfo", () => {
    const item = (gatsbyGB as { items: GoogleBooksItem[] }).items[0];
    const meta = extractGoogleBooksMetadata(item);
    expect(meta.description).toBeTruthy();
    expect(meta.google_volume_id).toBe(item.id);
    expect(meta.description_provider).toBe("google_books");
  });
});
