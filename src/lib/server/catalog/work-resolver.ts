import type {
  OpenLibrarySearchDoc,
  OpenLibraryWork,
  OpenLibraryEditionsResponse,
} from "./types";

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

export interface ResolvedWork {
  workKey: string | null;
  olWork: OpenLibraryWork | null;
  /** Winning search doc (TA mode); null in work-key mode. Seeds metadata. */
  searchDoc: OpenLibrarySearchDoc | null;
  /** work.covers[], sentinel-stripped + deduped. NOT capped (walker caps). */
  workCoverIds: number[];
  /** Lazy: fetches /works/{key}/editions.json on first call, memoized; []
   *  on failure or no editions. Called by WorkCoverWalker only when work
   *  covers miss the floor. */
  fetchEditionCoverIds: () => Promise<number[]>;
}

/** Decoded cover bytes + dimensions, or null = fetched-and-failed. */
export type FetchedCover = {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
} | null;

/** Result of a successful walk at a tier floor. Carries the fields the cover
 *  chain's CoverResolution needs from this source. */
export interface WalkerCover {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  byteCount: number;
  source: "openlibrary_work";
  openLibraryCoverId: number;
}

/** Hard ceiling on distinct cover IDs fetched across the whole resolve (work
 *  + edition covers, all tiers). Bounds dead-ID + latency cost. */
export const TOTAL_PROBE_CAP = 12;

export type WorkLookup =
  | { kind: "title-author"; title: string; author: string }
  | { kind: "work-key"; workKey: string };

/**
 * Injected OL fns. `resolveWork` takes these (rather than importing the
 * openlibrary client directly) so it's unit-testable without network and so
 * rate-limit-token acquisition stays the caller's (fetcher's) concern — these
 * fns run under the single OL token fetcher already acquired.
 */
export interface WorkResolverDeps {
  searchWorks: (
    title: string,
    author: string,
  ) => Promise<OpenLibrarySearchDoc[]>;
  fetchWork: (workId: string) => Promise<OpenLibraryWork | null>;
  fetchEditions: (
    workId: string,
  ) => Promise<OpenLibraryEditionsResponse | null>;
}

const OL_WORK_KEY_PREFIX = /^\/works\//;

// OL work IDs are interpolated into work/editions fetch URLs; validate the
// shape at this boundary so a malformed key (e.g. "garbage/..%2F..%2Fadmin"
// from a poisoned OL data doc) can never reach the network. Mirrors the
// OL_WORK_ID_RE guard in fetcher.ts's loadOpenLibraryData.
const OL_WORK_ID_RE = /^OL\d+W$/;

function editionCoverIds(res: OpenLibraryEditionsResponse | null): number[] {
  if (!res?.entries) return [];
  return collectCoverIds(res.entries.map((e) => e.covers ?? []));
}

/**
 * Resolve a lookup to a canonical OL work + its cover candidates. TA mode:
 * search → rank → fetch work. work-key mode: fetch work directly (skips
 * search/rank). Returns null when ranking finds nothing acceptable or the
 * work fetch fails. Editions are NOT fetched here — `fetchEditionCoverIds` is
 * a lazy, memoized thunk the cover walker calls only if work covers miss.
 */
export async function resolveWork(
  lookup: WorkLookup,
  deps: WorkResolverDeps,
): Promise<ResolvedWork | null> {
  let workKey: string;
  let searchDoc: OpenLibrarySearchDoc | null = null;

  if (lookup.kind === "title-author") {
    const docs = await deps.searchWorks(lookup.title, lookup.author);
    const winner = rankWorkCandidates(docs, {
      title: lookup.title,
      author: lookup.author,
    });
    if (!winner?.key) return null;
    workKey = winner.key;
    searchDoc = winner;
  } else {
    if (!lookup.workKey) return null;
    workKey = lookup.workKey;
  }

  const workId = workKey.replace(OL_WORK_KEY_PREFIX, "");
  if (!OL_WORK_ID_RE.test(workId)) return null;
  const olWork = await deps.fetchWork(workId);
  if (!olWork) return null;

  const workCoverIds = collectCoverIds([olWork.covers ?? []]);

  let editionsPromise: Promise<number[]> | null = null;
  const fetchEditionCoverIds = (): Promise<number[]> => {
    if (!editionsPromise) {
      editionsPromise = deps
        .fetchEditions(workId)
        .then(editionCoverIds)
        .catch(() => []);
    }
    return editionsPromise;
  };

  return { workKey, olWork, searchDoc, workCoverIds, fetchEditionCoverIds };
}

/**
 * Per-resolve cover walker. Fetches each candidate cover ID at most once
 * across all three tier passes (premium/basic/salvage), caching decoded
 * dimensions, and applies the per-tier floor against the cache. Phase 1 walks
 * work-level covers; phase 2 lazily fetches edition covers only after phase 1
 * misses the current floor (once per resolve). Created once per resolve,
 * threaded into the cover-chain ctx.
 */
export class WorkCoverWalker {
  private decoded = new Map<number, FetchedCover>();
  private orderedIds: number[];
  private readonly orderedSet = new Set<number>();
  private editionIdsLoaded = false;

  constructor(
    private readonly resolved: ResolvedWork,
    private readonly fetchCover: (id: number) => Promise<FetchedCover>,
  ) {
    this.orderedIds = [...resolved.workCoverIds];
    for (const id of this.orderedIds) this.orderedSet.add(id);
  }

  private async fetchOnce(id: number): Promise<FetchedCover> {
    if (this.decoded.has(id)) return this.decoded.get(id)!;
    if (this.decoded.size >= TOTAL_PROBE_CAP) return null;
    const entry = await this.fetchCover(id);
    this.decoded.set(id, entry);
    return entry;
  }

  private match(
    entry: FetchedCover,
    id: number,
    minWidth: number,
  ): WalkerCover | null {
    if (entry && entry.width >= minWidth) {
      return {
        bytes: entry.bytes,
        mime: entry.mime,
        width: entry.width,
        height: entry.height,
        byteCount: entry.bytes.length,
        source: "openlibrary_work",
        openLibraryCoverId: id,
      };
    }
    return null;
  }

  async tryAtFloor(minWidth: number): Promise<WalkerCover | null> {
    // Phase 1: work-level + any already-loaded edition covers.
    for (const id of this.orderedIds) {
      if (this.decoded.size >= TOTAL_PROBE_CAP && !this.decoded.has(id)) break;
      const entry = await this.fetchOnce(id);
      const hit = this.match(entry, id, minWidth);
      if (hit) return hit;
    }
    // Phase 2: lazy editions — fetch once, append new IDs, probe the new ones.
    if (!this.editionIdsLoaded) {
      this.editionIdsLoaded = true;
      const editionIds = await this.resolved.fetchEditionCoverIds();
      const newIds = collectCoverIds([editionIds]).filter(
        (id) => !this.decoded.has(id) && !this.orderedSet.has(id),
      );
      this.orderedIds = this.orderedIds.concat(newIds);
      for (const id of newIds) this.orderedSet.add(id);
      for (const id of newIds) {
        if (this.decoded.size >= TOTAL_PROBE_CAP) break;
        const entry = await this.fetchOnce(id);
        const hit = this.match(entry, id, minWidth);
        if (hit) return hit;
      }
    }
    return null;
  }
}
