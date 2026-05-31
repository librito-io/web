import type { OpenLibrarySearchDoc } from "./types";

/** Tokenize for acceptableMatch — Unicode-aware, lowercase, stopword-free. */
export function matchTokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "in",
  "on",
  "to",
  "for",
  "is",
  "are",
  "at",
  "by",
  "with",
  "from",
  "as",
]);

/**
 * Gate a title+author OL search result against the ctx title/author so we
 * don't accept a wrong book's cover when OL ranking returns a near-miss.
 *
 * Require BOTH:
 *   - Title-token overlap: at least min(2, ctxTitleTokens.length) significant
 *     (non-stopword) tokens in common. Two-token requirement prevents a single
 *     generic token ("story", "memoir") from passing the gate; the floor of
 *     min(2, len) keeps single-significant-token titles ("Annie Bot" reduced
 *     to "annie bot", "Beloved") gateable when ctx is short.
 *   - Author surname overlap: last whitespace token of any `doc.author_name`
 *     entry matches any surname extracted from ctx.author (last whitespace
 *     token per comma/semicolon/ampersand-split fragment). Surname-to-surname
 *     only — a doc author whose first name coincides with ctx's surname
 *     (or vice-versa) must NOT pass.
 */
export function acceptableMatch(
  doc: Pick<OpenLibrarySearchDoc, "title" | "author_name">,
  ctx: { title: string; author: string },
): boolean {
  const ctxTitleTokens = matchTokens(ctx.title).filter(
    (t) => !TITLE_STOPWORDS.has(t),
  );
  if (ctxTitleTokens.length === 0) return false;
  const docTitleTokens = matchTokens(doc.title ?? "").filter(
    (t) => !TITLE_STOPWORDS.has(t),
  );
  const overlapCount = ctxTitleTokens.filter((t) =>
    docTitleTokens.includes(t),
  ).length;
  const required = Math.min(2, ctxTitleTokens.length);
  if (overlapCount < required) return false;

  const ctxSurnames = new Set(
    ctx.author
      .split(/[,;&]/)
      .map((part) => matchTokens(part).at(-1))
      .filter((t): t is string => Boolean(t)),
  );
  if (ctxSurnames.size === 0) return false;
  const docSurnames = (doc.author_name ?? [])
    .map((name) => matchTokens(name).at(-1))
    .filter((t): t is string => Boolean(t));
  return docSurnames.some((s) => ctxSurnames.has(s));
}

/**
 * Adapted/abridged-edition title patterns. Load-bearing adapter rejection:
 * an adaptation often passes acceptableMatch on the real author's surname
 * (e.g. "1984 (adaptation)" by [Michael Dean, George Orwell]), so only this
 * denylist removes it. Defense-in-depth with edition_count ranking.
 */
export const ADAPTED_TITLE_RE =
  /\b(adaptation|abridged|graded reader|penguin readers|easy readers?|readers? level|stage \d|retold|simplified)\b|\((adaptation|abridged)\)/i;

/**
 * Rank OL search docs to the canonical work. Filter (acceptableMatch →
 * adapter denylist) then rank (edition_count DESC, first_publish_year ASC,
 * original order stable). Returns the winning doc or null if filters emptied
 * the list. Pure — no I/O.
 */
export function rankWorkCandidates(
  docs: OpenLibrarySearchDoc[],
  ctx: { title: string; author: string },
): OpenLibrarySearchDoc | null {
  const survivors = docs.filter(
    (d) => acceptableMatch(d, ctx) && !ADAPTED_TITLE_RE.test(d.title ?? ""),
  );
  if (survivors.length === 0) return null;
  return survivors
    .map((doc, i) => ({ doc, i }))
    .sort((a, b) => {
      const ec = (b.doc.edition_count ?? 0) - (a.doc.edition_count ?? 0);
      if (ec !== 0) return ec;
      const ya = a.doc.first_publish_year ?? Infinity;
      const yb = b.doc.first_publish_year ?? Infinity;
      if (ya !== yb) return ya - yb;
      return a.i - b.i;
    })[0].doc;
}

/**
 * Flatten ordered cover-ID lists into one deduped list, dropping OL "no
 * cover" sentinels (id <= 0). Preserves first-seen order. Pure — no fetch,
 * no cap (capping is the WorkCoverWalker's TOTAL_PROBE_CAP job).
 */
export function collectCoverIds(coverIdLists: number[][]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const list of coverIdLists) {
    for (const id of list) {
      if (id <= 0 || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
