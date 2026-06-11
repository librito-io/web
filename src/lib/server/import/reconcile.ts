// Kobo import reconcile matcher — librito-io/web#527.
//
// Pure, no I/O. Runs per book within one import to pair "absent" existing
// rows (source_uid missing from the incoming full set) with "new" incoming
// items (source_uid not yet in the DB), converting an on-device span re-drag
// — which Nickel implements as hard DELETE + recreate → fresh BookmarkID →
// fresh source_uid — into an in-place AMEND of the existing row instead of an
// accumulating duplicate.
//
// FULL-SET PRECONDITION (kobo-sync invariant #5): the agent re-sends the
// ENTIRE highlight set every run. "Absent" is only meaningful under that
// invariant — a partial / per-book import would make untouched rows look
// absent and manufacture false amends. If MAX_ITEMS ever forces chunking,
// chunks MUST be book-granular; a single book > MAX_ITEMS is unsupported.
//
// source='kobo' SCOPING IS LOAD-BEARING: ISBN-first book resolve means one
// book_id can hold PaperS3 rows too, and PaperS3 rows have source_uid NULL
// (which a naive matcher reads as "absent"). Existing rows are filtered to
// source='kobo' before any candidate logic.
//
// Guards bias EVERY failure mode toward a visible duplicate over a silent
// wrong merge (a false match transplants a web-authored note onto different
// text). See the 2026-06-11 reconcile design spec.

/** Existing highlight row, as SELECTed for the covered books (any source). */
export interface ExistingHighlight {
  id: string;
  book_id: string;
  source: string;
  source_uid: string | null;
  text: string;
  chapter_title: string | null;
  deleted_at: string | null;
  created_at: string;
}

/** One validated incoming item, with its resolved book_id. */
export interface IncomingItem {
  book_id: string;
  source_uid: string;
  text: string;
  chapter_title: string | null;
}

/** One row of the reconcile RPC's p_amends payload. */
export interface Amend {
  /** Existing highlight row id to UPDATE in place. */
  id: string;
  /** The NEW (incoming) source_uid the row adopts. */
  source_uid: string;
  /** Verbatim incoming text (never the normalized form). */
  text: string;
  chapter_title: string | null;
}

export interface ReconcileResult {
  /** RPC p_amends payload. amends[i] pairs with matchedAbsentCreatedAt[i]. */
  amends: Amend[];
  /** Instrumentation only: created_at of each matched absent row. */
  matchedAbsentCreatedAt: string[];
  /** Instrumentation only: absent rows that matched nothing. */
  unmatchedAbsentCount: number;
}

/** Shorter-text floor: below this many chars post-normalization, no match. */
const MIN_OVERLAP = 20;

/**
 * Match-only normalization: collapse every whitespace run to one space and
 * trim. `\s` so NBSP / unicode spaces collapse identically on both sides. NO
 * case-folding, NO unicode normalization — both texts come verbatim from the
 * same book source; extra normalization only adds false-match surface. (Kobo
 * texts really arrive with a leading "\t " — normalize before any length
 * check.) Match-only: amends/upserts write the verbatim incoming text.
 */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * True iff `needle` appears in `haystack` at WORD BOUNDARIES — the chars
 * adjacent to the match site are a space or the string edge. Both args MUST
 * already be normalizeText'd (runs are single spaces). Bare substring is not
 * enough: "he said hello" must NOT match inside "she said hello".
 */
export function containsAtWordBoundary(
  haystack: string,
  needle: string,
): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const beforeOk = idx === 0 || haystack[idx - 1] === " ";
    const after = idx + needle.length;
    const afterOk = after === haystack.length || haystack[after] === " ";
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
}

/**
 * Normalized word-boundary containment in EITHER direction (equality counts —
 * covers delete-then-rehighlight of the same passage). Inputs are already
 * normalized. Equal-length inputs route through containsAtWordBoundary(bNorm,
 * aNorm); the boundary geometry means they match iff identical.
 */
export function textMatch(aNorm: string, bNorm: string): boolean {
  return aNorm.length <= bNorm.length
    ? containsAtWordBoundary(bNorm, aNorm)
    : containsAtWordBoundary(aNorm, bNorm);
}

/**
 * Guard-passing overlap for one (absent, incoming) pair, or null if the pair
 * fails any guard. Overlap = the shorter normalized length (match ⇒
 * containment, so the shorter text is the contained one).
 *
 * Guard 1 — length floor: shorter text >= 20 chars post-normalization.
 * Guard 2 — chapter gate: if BOTH chapter_titles are non-empty (post-
 * normalization) and differ, no match. Empty/null on either side passes (the
 * agent's chapter title comes from a LEFT JOIN that legitimately misses).
 */
function pairOverlap(a: ExistingHighlight, n: IncomingItem): number | null {
  const aT = normalizeText(a.text);
  const nT = normalizeText(n.text);
  if (!textMatch(aT, nT)) return null;
  const overlap = Math.min(aT.length, nT.length);
  if (overlap < MIN_OVERLAP) return null; // guard 1
  const aC = normalizeText(a.chapter_title ?? "");
  const nC = normalizeText(n.chapter_title ?? "");
  if (aC.length > 0 && nC.length > 0 && aC !== nC) return null; // guard 2
  return overlap;
}

/** @internal test seam for the guard table tests — not part of the API. */
export const __pairOverlap = pairOverlap;
