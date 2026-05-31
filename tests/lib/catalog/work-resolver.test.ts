import { describe, it, expect } from "vitest";
import {
  rankWorkCandidates,
  collectCoverIds,
} from "../../../src/lib/server/catalog/work-resolver";
import type { OpenLibrarySearchDoc } from "../../../src/lib/server/catalog/types";

const martian = { title: "The Martian", author: "Andy Weir" };

describe("rankWorkCandidates", () => {
  it("picks the highest edition_count survivor (The Martian work over boxset)", () => {
    const docs: OpenLibrarySearchDoc[] = [
      {
        key: "/works/BOX",
        title: "The Martian / Artemis / Project Hail Mary",
        author_name: ["Andy Weir"],
        edition_count: 1,
        first_publish_year: 2022,
      },
      {
        key: "/works/OL17091839W",
        title: "The Martian",
        author_name: ["Andy Weir"],
        edition_count: 74,
        first_publish_year: 2011,
      },
    ];
    expect(rankWorkCandidates(docs, martian)?.key).toBe("/works/OL17091839W");
  });

  it("filters the adapter edition by title pattern even when the author surname is present", () => {
    const docs: OpenLibrarySearchDoc[] = [
      {
        key: "/works/ADAPT",
        title: "1984 (adaptation)",
        author_name: ["Michael Dean", "George Orwell"],
        edition_count: 4,
        first_publish_year: 2003,
      },
      {
        key: "/works/REAL",
        title: "1984",
        author_name: ["George Orwell", "Amélie Audiberti"],
        edition_count: 8,
        first_publish_year: 2021,
      },
    ];
    expect(
      rankWorkCandidates(docs, { title: "1984", author: "George Orwell" })?.key,
    ).toBe("/works/REAL");
  });

  it("keeps a co-authored (translator/illustrator) edition — author-present, not author-sole", () => {
    const docs: OpenLibrarySearchDoc[] = [
      {
        key: "/works/REAL",
        title: "1984",
        author_name: ["George Orwell", "Fido Nesti"],
        edition_count: 7,
        first_publish_year: 1984,
      },
    ];
    expect(
      rankWorkCandidates(docs, { title: "1984", author: "George Orwell" })?.key,
    ).toBe("/works/REAL");
  });

  it("returns null when the queried author is absent from every doc", () => {
    const docs: OpenLibrarySearchDoc[] = [
      {
        key: "/works/X",
        title: "The Martian",
        author_name: ["Someone Else"],
        edition_count: 50,
      },
    ];
    expect(rankWorkCandidates(docs, martian)).toBeNull();
  });

  it("returns null when every doc is an adaptation", () => {
    const docs: OpenLibrarySearchDoc[] = [
      {
        key: "/works/A",
        title: "The Martian (abridged)",
        author_name: ["Andy Weir"],
        edition_count: 3,
      },
      {
        key: "/works/B",
        title: "The Martian (Penguin Readers)",
        author_name: ["Andy Weir"],
        edition_count: 2,
      },
    ];
    expect(rankWorkCandidates(docs, martian)).toBeNull();
  });

  it("tiebreaks equal edition_count by earliest first_publish_year", () => {
    const docs: OpenLibrarySearchDoc[] = [
      {
        key: "/works/NEW",
        title: "The Martian",
        author_name: ["Andy Weir"],
        edition_count: 10,
        first_publish_year: 2015,
      },
      {
        key: "/works/OLD",
        title: "The Martian",
        author_name: ["Andy Weir"],
        edition_count: 10,
        first_publish_year: 2011,
      },
    ];
    expect(rankWorkCandidates(docs, martian)?.key).toBe("/works/OLD");
  });
});

describe("collectCoverIds", () => {
  it("flattens lists in order, strips id<=0 sentinels, dedupes first-seen", () => {
    expect(
      collectCoverIds([
        [11447888, -1, 10860735],
        [10860735, 0, 8223196],
      ]),
    ).toEqual([11447888, 10860735, 8223196]);
  });

  it("returns [] for empty input", () => {
    expect(collectCoverIds([])).toEqual([]);
    expect(collectCoverIds([[], []])).toEqual([]);
  });
});
