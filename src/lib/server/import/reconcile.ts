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
 * normalized.
 */
export function textMatch(aNorm: string, bNorm: string): boolean {
  return aNorm.length <= bNorm.length
    ? containsAtWordBoundary(bNorm, aNorm)
    : containsAtWordBoundary(aNorm, bNorm);
}
