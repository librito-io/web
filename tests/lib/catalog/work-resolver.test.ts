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

import { resolveWork } from "../../../src/lib/server/catalog/work-resolver";

function deps(over: Partial<Parameters<typeof resolveWork>[1]> = {}) {
  return {
    searchWorks: async () => [],
    fetchWork: async () => null,
    fetchEditions: async () => null,
    ...over,
  } as Parameters<typeof resolveWork>[1];
}

describe("resolveWork (title-author)", () => {
  it("searches, ranks, fetches the winning work, assembles workCoverIds", async () => {
    const r = await resolveWork(
      { kind: "title-author", title: "The Martian", author: "Andy Weir" },
      deps({
        searchWorks: async () => [
          {
            key: "/works/OL17091839W",
            title: "The Martian",
            author_name: ["Andy Weir"],
            edition_count: 74,
            first_publish_year: 2011,
          },
        ],
        fetchWork: async (key: string) => {
          expect(key).toBe("OL17091839W"); // /works/ prefix stripped
          return { description: "synopsis", covers: [11447888, -1, 10860735] };
        },
      }),
    );
    expect(r?.workKey).toBe("/works/OL17091839W");
    expect(r?.olWork?.description).toBe("synopsis");
    expect(r?.workCoverIds).toEqual([11447888, 10860735]);
    expect(r?.searchDoc?.key).toBe("/works/OL17091839W");
  });

  it("returns null when ranking finds no acceptable work", async () => {
    const r = await resolveWork(
      { kind: "title-author", title: "The Martian", author: "Andy Weir" },
      deps({
        searchWorks: async () => [
          { title: "Unrelated", author_name: ["Nobody"], edition_count: 1 },
        ],
      }),
    );
    expect(r).toBeNull();
  });

  it("fetchEditionCoverIds lazily fetches + memoizes editions", async () => {
    let editionFetches = 0;
    const r = await resolveWork(
      { kind: "title-author", title: "The Martian", author: "Andy Weir" },
      deps({
        searchWorks: async () => [
          {
            key: "/works/OL1W",
            title: "The Martian",
            author_name: ["Andy Weir"],
            edition_count: 74,
          },
        ],
        fetchWork: async () => ({ covers: [1] }),
        fetchEditions: async () => {
          editionFetches++;
          return { entries: [{ covers: [2, -1] }, { covers: [3] }] };
        },
      }),
    );
    expect(editionFetches).toBe(0); // not fetched during resolveWork
    expect(await r!.fetchEditionCoverIds()).toEqual([2, 3]);
    expect(editionFetches).toBe(1);
    await r!.fetchEditionCoverIds(); // memoized
    expect(editionFetches).toBe(1);
  });
});

describe("resolveWork (work-key)", () => {
  it("skips search/rank, fetches the work directly, searchDoc null", async () => {
    const r = await resolveWork(
      { kind: "work-key", workKey: "/works/OL99W" },
      deps({
        fetchWork: async (key: string) => {
          expect(key).toBe("OL99W");
          return { covers: [5] };
        },
      }),
    );
    expect(r?.workKey).toBe("/works/OL99W");
    expect(r?.workCoverIds).toEqual([5]);
    expect(r?.searchDoc).toBeNull();
  });

  it("returns null when the work fetch fails", async () => {
    const r = await resolveWork(
      { kind: "work-key", workKey: "/works/OL1W" },
      deps({ fetchWork: async () => null }),
    );
    expect(r).toBeNull();
  });

  it("returns null for a malformed work key without fetching the work", async () => {
    let fetchWorkCalls = 0;
    const r = await resolveWork(
      { kind: "work-key", workKey: "/works/garbage/..%2F..%2Fadmin" },
      deps({
        fetchWork: async () => {
          fetchWorkCalls++;
          return { covers: [1] };
        },
      }),
    );
    expect(r).toBeNull();
    expect(fetchWorkCalls).toBe(0);
  });
});

describe("resolveWork (work-doc)", () => {
  it("reuses the supplied work doc without calling fetchWork (#486)", async () => {
    let fetchWorkCalls = 0;
    const r = await resolveWork(
      {
        kind: "work-doc",
        workKey: "/works/OL42W",
        olWork: { description: "supplied", covers: [7, -1, 8] },
      },
      deps({
        fetchWork: async () => {
          fetchWorkCalls++;
          return null;
        },
      }),
    );
    expect(fetchWorkCalls).toBe(0);
    expect(r?.workKey).toBe("/works/OL42W");
    expect(r?.olWork?.description).toBe("supplied");
    expect(r?.workCoverIds).toEqual([7, 8]);
    expect(r?.searchDoc).toBeNull();
  });

  it("still enforces the work-id shape guard (malformed key → null, no editions path)", async () => {
    const r = await resolveWork(
      {
        kind: "work-doc",
        workKey: "/works/garbage/..%2Fadmin",
        olWork: { covers: [1] },
      },
      deps(),
    );
    expect(r).toBeNull();
  });
});

import { WorkCoverWalker } from "../../../src/lib/server/catalog/work-resolver";
import type { ResolvedWork } from "../../../src/lib/server/catalog/work-resolver";

function fakeResolvedWork(
  over: Partial<ResolvedWork> &
    Pick<ResolvedWork, "workCoverIds" | "fetchEditionCoverIds">,
): ResolvedWork {
  return { workKey: "/works/X", olWork: null, searchDoc: null, ...over };
}

function stubFetch(
  map: Record<number, { width: number; height: number } | null>,
) {
  const calls: number[] = [];
  const fn = async (id: number) => {
    calls.push(id);
    const e = map[id];
    if (!e) return null;
    return {
      bytes: new Uint8Array([1]),
      mime: "image/jpeg",
      width: e.width,
      height: e.height,
    };
  };
  return { fn, calls };
}

describe("WorkCoverWalker", () => {
  it("returns the first work cover meeting the floor; skips earlier dead IDs", async () => {
    const { fn, calls } = stubFetch({
      1: null,
      2: { width: 1300, height: 2000 },
    });
    const w = new WorkCoverWalker(
      fakeResolvedWork({
        workCoverIds: [1, 2],
        fetchEditionCoverIds: async () => [],
      }),
      fn,
    );
    const r = await w.tryAtFloor(1200);
    expect(r?.openLibraryCoverId).toBe(2);
    expect(r?.source).toBe("openlibrary_work");
    expect(calls).toEqual([1, 2]);
  });

  it("fetches each ID at most once across premium/basic/salvage calls", async () => {
    const { fn, calls } = stubFetch({ 1: { width: 800, height: 1200 } });
    const w = new WorkCoverWalker(
      fakeResolvedWork({
        workCoverIds: [1],
        fetchEditionCoverIds: async () => [],
      }),
      fn,
    );
    expect(await w.tryAtFloor(1200)).toBeNull(); // premium miss
    const basic = await w.tryAtFloor(300);
    expect(basic?.openLibraryCoverId).toBe(1); // basic hit from cache
    expect(calls).toEqual([1]); // fetched ONCE, not 3x
  });

  it("invokes the editions thunk only after work covers miss, and only once", async () => {
    const { fn, calls } = stubFetch({
      1: { width: 100, height: 150 },
      99: { width: 1300, height: 2000 },
    });
    let editionCalls = 0;
    const w = new WorkCoverWalker(
      fakeResolvedWork({
        workCoverIds: [1],
        fetchEditionCoverIds: async () => {
          editionCalls++;
          return [99];
        },
      }),
      fn,
    );
    const r = await w.tryAtFloor(1200);
    expect(r?.openLibraryCoverId).toBe(99);
    expect(editionCalls).toBe(1);
    await w.tryAtFloor(300); // editions already loaded
    expect(editionCalls).toBe(1);
    expect(calls).toEqual([1, 99]);
  });

  it("stops fetching past TOTAL_PROBE_CAP distinct IDs", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const map: Record<number, null> = {};
    for (const id of ids) map[id] = null;
    const { fn, calls } = stubFetch(map);
    const w = new WorkCoverWalker(
      fakeResolvedWork({
        workCoverIds: ids,
        fetchEditionCoverIds: async () => [],
      }),
      fn,
    );
    await w.tryAtFloor(1200);
    await w.tryAtFloor(300);
    await w.tryAtFloor(240);
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  it("returns null when all candidates miss every floor", async () => {
    const { fn } = stubFetch({ 1: { width: 100, height: 150 } });
    const w = new WorkCoverWalker(
      fakeResolvedWork({
        workCoverIds: [1],
        fetchEditionCoverIds: async () => [],
      }),
      fn,
    );
    expect(await w.tryAtFloor(240)).toBeNull();
  });
});
