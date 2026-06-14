import { describe, it, expect } from "vitest";
import {
  normalizeText,
  containsAtWordBoundary,
  textMatch,
} from "$lib/server/import/reconcile";

describe("normalizeText", () => {
  it("collapses every whitespace run to a single space and trims", () => {
    expect(normalizeText("  he said   hello\n")).toBe("he said hello");
  });

  it("normalizes the literal Kobo leading tab-space prefix", () => {
    expect(normalizeText("\t the quick brown fox")).toBe("the quick brown fox");
  });

  it("collapses NBSP and unicode spaces via \\s (identical on both sides)", () => {
    // U+00A0 NBSP, U+2009 thin space.
    expect(normalizeText("a b c")).toBe("a b c");
  });

  it("does NOT case-fold or unicode-normalize", () => {
    expect(normalizeText("The CAFÉ")).toBe("The CAFÉ");
  });
});

describe("containsAtWordBoundary", () => {
  it("matches at the string edges (equality)", () => {
    expect(containsAtWordBoundary("he said hello", "he said hello")).toBe(true);
  });

  it("matches a whole-word run flanked by spaces", () => {
    expect(containsAtWordBoundary("a he said hello b", "he said hello")).toBe(
      true,
    );
  });

  it("rejects a mid-word containment (she said vs he said)", () => {
    // "he said hello to everyone" must NOT match inside "she said hello to everyone".
    expect(
      containsAtWordBoundary(
        "she said hello to everyone",
        "he said hello to everyone",
      ),
    ).toBe(false);
  });

  it("rejects an empty needle", () => {
    expect(containsAtWordBoundary("anything", "")).toBe(false);
  });

  it("matches a needle anchored at the end of a longer haystack", () => {
    expect(containsAtWordBoundary("hello world", "world")).toBe(true);
  });
});

describe("textMatch", () => {
  it("is true when the shorter contains the longer-side at boundaries (either direction)", () => {
    expect(textMatch("he said hello", "well he said hello there")).toBe(true);
    expect(textMatch("well he said hello there", "he said hello")).toBe(true);
  });

  it("is true on equality", () => {
    expect(textMatch("he said hello", "he said hello")).toBe(true);
  });

  it("is false when neither contains the other", () => {
    expect(textMatch("he said hello", "she said goodbye")).toBe(false);
  });

  it("equal length but different strings do not match", () => {
    expect(textMatch("abcde", "abcdf")).toBe(false);
  });
});

import { __pairOverlap } from "$lib/server/import/reconcile";
import type {
  ExistingHighlight,
  IncomingItem,
} from "$lib/server/import/reconcile";

function ex(overrides: Partial<ExistingHighlight> = {}): ExistingHighlight {
  return {
    id: "ex-1",
    book_id: "book-1",
    source: "kobo",
    source_uid: "old-uid",
    text: "the quick brown fox jumps over",
    chapter_title: null,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    removed_from_device_at: null,
    ...overrides,
  };
}

function inc(overrides: Partial<IncomingItem> = {}): IncomingItem {
  return {
    book_id: "book-1",
    source_uid: "new-uid",
    text: "the quick brown fox jumps over",
    chapter_title: null,
    ...overrides,
  };
}

describe("__pairOverlap guards", () => {
  it("returns the shorter normalized length when contained and >= 20", () => {
    // "the quick brown fox jumps" is 25 chars, contained in the longer text.
    const a = ex({ text: "the quick brown fox jumps" });
    const n = inc({ text: "well the quick brown fox jumps over the lazy dog" });
    expect(__pairOverlap(a, n)).toBe(25);
  });

  it("returns null when texts do not match", () => {
    expect(
      __pairOverlap(ex({ text: "completely different words here" }), inc()),
    ).toBeNull();
  });

  it("length floor: 19 rejects, 20 accepts, 21 accepts", () => {
    const t19 = "a".repeat(9) + " " + "b".repeat(9); // 19 chars
    const t20 = "a".repeat(9) + " " + "b".repeat(10); // 20 chars
    const t21 = "a".repeat(10) + " " + "b".repeat(10); // 21 chars
    expect(__pairOverlap(ex({ text: t19 }), inc({ text: t19 }))).toBeNull();
    expect(__pairOverlap(ex({ text: t20 }), inc({ text: t20 }))).toBe(20);
    expect(__pairOverlap(ex({ text: t21 }), inc({ text: t21 }))).toBe(21);
  });

  it("chapter gate: both non-empty + different → no match", () => {
    const a = ex({ chapter_title: "Chapter One" });
    const n = inc({ chapter_title: "Chapter Two" });
    expect(__pairOverlap(a, n)).toBeNull();
  });

  it("chapter gate: empty/null on either side passes", () => {
    expect(
      __pairOverlap(
        ex({ chapter_title: null }),
        inc({ chapter_title: "Chapter Two" }),
      ),
    ).not.toBeNull();
    expect(
      __pairOverlap(
        ex({ chapter_title: "Chapter One" }),
        inc({ chapter_title: "" }),
      ),
    ).not.toBeNull();
    expect(
      __pairOverlap(
        ex({ chapter_title: "   " }),
        inc({ chapter_title: "Chapter Two" }),
      ),
    ).not.toBeNull();
  });

  it("chapter gate compares after whitespace normalization", () => {
    // Same chapter, differing only by whitespace → must NOT block.
    const a = ex({ chapter_title: "Chapter   One" });
    const n = inc({ chapter_title: " Chapter One " });
    expect(__pairOverlap(a, n)).not.toBeNull();
  });
});

import { computeReconcile } from "$lib/server/import/reconcile";

// Helper: a >= 20-char base passage so the length floor never gets in the way
// of the structural tests below. Distinct fragments are built by slicing it.
const BASE = "the quick brown fox jumps over the lazy dog tonight";

const CUTOFF = new Date("2026-06-14T12:00:00.000Z");

describe("computeReconcile", () => {
  it("amends an absent row when a new item contains it (one direction)", () => {
    const existing = [
      ex({ id: "A", source_uid: "u_old", text: BASE.slice(0, 30) }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([
      { id: "A", source_uid: "u_new", text: BASE, chapter_title: null },
    ]);
    expect(r.matchedAbsentCreatedAt).toEqual(["2026-01-01T00:00:00.000Z"]);
    expect(r.unmatchedAbsentCount).toBe(0);
  });

  it("amends in the other direction (new item is the shorter, contained text)", () => {
    const existing = [ex({ id: "A", source_uid: "u_old", text: BASE })];
    const incoming = [inc({ source_uid: "u_new", text: BASE.slice(0, 30) })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toHaveLength(1);
    expect(r.amends[0].text).toBe(BASE.slice(0, 30)); // verbatim incoming, shorter
  });

  it("writes the verbatim incoming text, never the normalized form", () => {
    const existing = [
      ex({ id: "A", source_uid: "u_old", text: BASE.slice(0, 30) }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: "\t " + BASE })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends[0].text).toBe("\t " + BASE); // raw, with the tab-space prefix
  });

  it("worked example 1: (A1,N1)=50,(A2,N1)=40,(A2,N2)=40 → A1↔N1 only", () => {
    // Overlap is the shorter length; build texts so the lengths land at 50/40.
    const big = "x".repeat(50); // A1 & N1 share this 50-char run
    const mid = "y".repeat(40); // A2 shares a 40-char run with both N1 and N2
    const existing = [
      ex({ id: "A1", source_uid: "a1", text: big }),
      ex({ id: "A2", source_uid: "a2", text: mid }),
    ];
    const incoming = [
      inc({ source_uid: "n1", text: big + " " + mid }), // contains both big and mid
      inc({ source_uid: "n2", text: mid }),
    ];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([
      {
        id: "A1",
        source_uid: "n1",
        text: big + " " + mid,
        chapter_title: null,
      },
    ]);
    expect(r.unmatchedAbsentCount).toBe(1); // A2 matched nothing (tie)
  });

  it("worked example 2 shape: N1 ties across A,B; N2 matches A only at lower overlap → no amends", () => {
    // Multi-word fixtures so every cited pair is a REAL word-boundary match
    // (single-char runs can't form a contained sub-run — they'd silently
    // degenerate). Overlaps: (A,N1)=21,(B,N1)=21 tie; (A,N2)=20 strictly lower
    // and B does NOT contain N2. Mirrors the spec's 50/50/40 structure.
    const N1 = "the quick brown foxes"; //                21 chars
    const N2 = "foxes leap high here"; //                 20 chars, ⊂ A only
    const existing = [
      ex({
        id: "A",
        source_uid: "a",
        text: "the quick brown foxes leap high here",
      }),
      ex({
        id: "B",
        source_uid: "b",
        text: "watch the quick brown foxes today",
      }),
    ];
    const incoming = [
      inc({ source_uid: "n1", text: N1 }), // contained in BOTH A and B (tie)
      inc({ source_uid: "n2", text: N2 }), // contained in A only, overlap 20 < 21
    ];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]); // N1 tied → no match; (A,N2) is not A's max → rejected
    expect(r.unmatchedAbsentCount).toBe(2);
  });

  it("both-grow ties bail (A contained in N1 and N2 both at len(A))", () => {
    const a = "z".repeat(30);
    const existing = [ex({ id: "A", source_uid: "a", text: a })];
    const incoming = [
      inc({ source_uid: "n1", text: a + " more words here" }),
      inc({ source_uid: "n2", text: "lead in " + a }),
    ];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]); // overlap len(A) for both → tie → bail
    expect(r.unmatchedAbsentCount).toBe(1);
  });

  it("merge: 2 absent both contained in 1 new → longest-overlap absent wins, loser counted unmatched", () => {
    // Multi-word so BOTH absent rows are real competing candidates for N
    // (single-char runs would make SHORT a non-match → arbitration untested).
    // A1 ⊂ N (overlap 30, prefix); A2 ⊂ N (overlap 27, suffix). N's strict
    // unique max is A1 → A1 amends, A2 loses and is counted unmatched (→ stamp).
    const existing = [
      ex({
        id: "A1",
        source_uid: "a1",
        text: "the quick brown fox jumps over",
      }), // 30
      ex({ id: "A2", source_uid: "a2", text: "the lazy dog sleeps soundly" }), //    27
    ];
    const incoming = [
      inc({
        source_uid: "n",
        text: "the quick brown fox jumps over the lazy dog sleeps soundly",
      }),
    ];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toHaveLength(1);
    expect(r.amends[0].id).toBe("A1"); // 30 > 27, strict unique max for N
    expect(r.unmatchedAbsentCount).toBe(1); // A2 loses, will be stamped
  });

  it("split: 1 absent containing 2 new fragments → bigger fragment wins, sibling inserts", () => {
    // A contains BOTH new fragments at word boundaries (real competing
    // candidates for A). N1 ⊂ A overlap 30 (prefix); N2 ⊂ A overlap 23 (suffix).
    // A's strict unique max is N1 → A↔N1 amends; N2 is not A's max → inserts.
    const existing = [
      ex({
        id: "A",
        source_uid: "a",
        text: "the quick brown fox jumps over the lazy dog",
      }),
    ];
    const incoming = [
      inc({ source_uid: "big", text: "the quick brown fox jumps over" }), // 30 ⊂ A
      inc({ source_uid: "small", text: "jumps over the lazy dog" }), //       23 ⊂ A
    ];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toHaveLength(1);
    expect(r.amends[0].source_uid).toBe("big"); // 30 > 23 strict max
    expect(r.amends[0].text).toBe("the quick brown fox jumps over"); // verbatim bigger fragment
  });

  it("sub-floor shrink does NOT match → duplicate (acceptance §11 degrade path)", () => {
    // A re-drag shrunk below the 20-char floor must leave a duplicate, never a
    // wrong merge: the contained fragment is real but ducks the floor.
    const existing = [
      ex({
        id: "A",
        source_uid: "old",
        text: "the quick brown fox jumps over",
      }),
    ];
    const incoming = [inc({ source_uid: "new", text: "quick brown" })]; // 11 chars < 20
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]); // floor rejects the only candidate pair
    expect(r.unmatchedAbsentCount).toBe(1); // A unmatched (→ stamp); "new" inserts downstream
  });

  it("includes a TRASHED absent row as a candidate (trash intent survives a re-drag)", () => {
    const existing = [
      ex({
        id: "T",
        source_uid: "u_old",
        text: BASE.slice(0, 30),
        deleted_at: "2026-02-02T00:00:00.000Z",
      }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([
      { id: "T", source_uid: "u_new", text: BASE, chapter_title: null },
    ]);
  });

  it("excludes PaperS3 rows from candidacy (source scoping)", () => {
    const existing = [
      ex({ id: "P3", source: "papers3", source_uid: null, text: BASE }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]); // papers3 row never absent/matched
    expect(r.unmatchedAbsentCount).toBe(0);
  });

  it("does not pair across books", () => {
    const existing = [
      ex({
        id: "A",
        book_id: "book-1",
        source_uid: "u_old",
        text: BASE.slice(0, 30),
      }),
    ];
    const incoming = [
      inc({ book_id: "book-2", source_uid: "u_new", text: BASE }),
    ];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]);
    expect(r.unmatchedAbsentCount).toBe(0); // A's book-1 is uncovered → untouched
  });

  it("ignores a row whose uid is still present (not absent)", () => {
    const existing = [ex({ id: "A", source_uid: "u_keep", text: BASE })];
    const incoming = [inc({ source_uid: "u_keep", text: BASE })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]);
    expect(r.unmatchedAbsentCount).toBe(0);
  });

  it("produces deterministic, source_uid-sorted amend output", () => {
    const fragA = "a".repeat(30);
    const fragB = "b".repeat(30);
    const existing = [
      ex({ id: "ZA", source_uid: "z_a", text: fragA }),
      ex({ id: "AB", source_uid: "a_b", text: fragB }),
    ];
    const incoming = [
      inc({ source_uid: "n_z", text: fragA + " tail" }),
      inc({ source_uid: "n_a", text: fragB + " tail" }),
    ];
    const r1 = computeReconcile(existing, incoming, CUTOFF);
    const r2 = computeReconcile(
      [...existing].reverse(),
      [...incoming].reverse(),
      CUTOFF,
    );
    expect(r1.amends).toEqual(r2.amends); // order-independent result
  });

  it("counts an absent row as unmatched when the book has no fresh items (early-continue path)", () => {
    // absent.length > 0 but fresh.length === 0 → the per-book early-continue
    // branch must still count the absent row (unmatchedAbsentCount drives the
    // downstream stamp decision).
    const existing = [
      ex({ id: "GONE", source_uid: "u_gone", text: BASE }), // absent (uid not in incoming)
      ex({ id: "STAY", source_uid: "u_stay", text: BASE }), // present (uid in incoming)
    ];
    const incoming = [inc({ source_uid: "u_stay", text: BASE })]; // only u_stay → no fresh items
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]);
    expect(r.unmatchedAbsentCount).toBe(1);
  });
});

describe("computeReconcile — windowed candidacy gate (#533)", () => {
  const BASE2 = "the quick brown fox jumps over the lazy dog tonight";

  it("unstamped absent row is a candidate (amends)", () => {
    const existing = [
      ex({
        id: "A",
        source_uid: "u_old",
        text: BASE2.slice(0, 30),
        removed_from_device_at: null,
      }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE2 })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toHaveLength(1);
    expect(r.amends[0].id).toBe("A");
  });

  it("absent row stamped WITHIN the window (> cutoff) is a candidate (amends)", () => {
    const existing = [
      ex({
        id: "A",
        source_uid: "u_old",
        text: BASE2.slice(0, 30),
        removed_from_device_at: "2026-06-14T12:01:00.000Z",
      }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE2 })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toHaveLength(1);
  });

  it("absent row stamped BEYOND the window (<= cutoff) is excluded — no amend", () => {
    const existing = [
      ex({
        id: "A",
        source_uid: "u_old",
        text: BASE2.slice(0, 30),
        removed_from_device_at: "2026-06-14T11:59:00.000Z",
      }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE2 })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toEqual([]);
  });

  it("a stale-stamped row does NOT consume a fresh item that should pair elsewhere", () => {
    const existing = [
      ex({
        id: "STALE",
        source_uid: "u_stale",
        text: BASE2.slice(0, 30),
        removed_from_device_at: "2026-06-14T11:00:00.000Z",
      }),
      ex({
        id: "FRESH",
        source_uid: "u_fresh",
        text: BASE2.slice(0, 30),
        removed_from_device_at: "2026-06-14T12:30:00.000Z",
      }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE2 })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.amends).toHaveLength(1);
    expect(r.amends[0].id).toBe("FRESH");
  });

  it("diagnostic records stamped textMatches on BOTH sides of the cutoff", () => {
    const existing = [
      ex({
        id: "WITHIN",
        source_uid: "u_within",
        text: BASE2.slice(0, 30),
        removed_from_device_at: "2026-06-14T12:30:00.000Z",
      }),
      ex({
        id: "BEYOND",
        source_uid: "u_beyond",
        text: BASE2.slice(0, 30),
        removed_from_device_at: "2026-06-14T11:30:00.000Z",
      }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE2 })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.stampedTextMatches).toEqual(
      expect.arrayContaining([
        { removedAt: "2026-06-14T12:30:00.000Z", withinCutoff: true },
        { removedAt: "2026-06-14T11:30:00.000Z", withinCutoff: false },
      ]),
    );
    expect(r.stampedTextMatches).toHaveLength(2);
  });

  it("diagnostic does NOT record an unstamped absent row (null-gap bucket)", () => {
    const existing = [
      ex({
        id: "A",
        source_uid: "u_old",
        text: BASE2.slice(0, 30),
        removed_from_device_at: null,
      }),
    ];
    const incoming = [inc({ source_uid: "u_new", text: BASE2 })];
    const r = computeReconcile(existing, incoming, CUTOFF);
    expect(r.stampedTextMatches).toEqual([]);
  });
});
