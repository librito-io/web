import type { FetchOutcome, LegOutcome } from "./chain";
import { stripMarketingCruft } from "./cleanup";
import type { ItunesResult } from "./itunes";
import type {
  GoogleBooksItem,
  OpenLibraryDataDoc,
  OpenLibraryWork,
} from "./types";

// State shape for any GB-fed leg. Resolver fetches the GB volume once per
// resolve and threads the outcome to every GB leg. `apiKeySet: false` is
// distinct so the disabled-provider TTL bucket (24h) fires only when the
// operator hasn't configured the API key — not when GB legitimately had
// no data for the lookup.
export type GbState =
  | { apiKeySet: false }
  | { apiKeySet: true; outcome: FetchOutcome<GoogleBooksItem> };

// State shape for the iTunes description leg. `hasIsbn: false` covers the
// TA-resolve path where iTunes can't be queried (no ISBN to feed the
// lookup endpoint). Cover chain's iTunes lookup is independent and lives
// in `tryItunes` — description leg here gets its own fetch + budget
// (deferred memoization, follow-up issue).
export type ItunesDescriptionState =
  | { hasIsbn: false }
  | { hasIsbn: true; outcome: FetchOutcome<ItunesResult> };

// ── description ──────────────────────────────────────────────────────────────

// GB serves library-distribution stub volumes whose only description is this
// boilerplate (e.g. volume P7g_rgEACAAJ for The Martian). Reject as a
// description source so the walker falls through to iTunes. Distinct from
// stripMarketingCruft (de-junks *real* descriptions) — this rejects a
// non-description. Must run BEFORE stripMarketingCruft.
const LIBRARY_STUB_RE =
  /\bfor use in (schools|libraries)( and (schools|libraries))?\s+only\b/i;

export function classifyDescriptionFromOpenLibrary(
  olWork: OpenLibraryWork | null,
): LegOutcome<string> {
  if (olWork == null) return { kind: "no_data", provider: "openlibrary" };
  const raw = olWork.description;
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "value" in raw
        ? raw.value
        : null;
  // OL description values arrive with leading/trailing whitespace from the
  // MARC pipeline (often a trailing newline on `description.value` strings).
  // Match the pre-refit `extractOpenLibraryMetadata` behaviour — trim before
  // returning, fold whitespace-only into the empty branch so the walker
  // advances to the next leg rather than persisting blank-ish text.
  const trimmed = text?.trim();
  if (!trimmed) return { kind: "empty", provider: "openlibrary" };
  return { kind: "success", value: trimmed, provider: "openlibrary" };
}

export function classifyDescriptionFromGoogleBooks(
  state: GbState,
): LegOutcome<string> {
  if (!state.apiKeySet) return { kind: "disabled" };
  const { outcome } = state;
  if (outcome.kind === "rate_limited") return { kind: "rate_limited" };
  if (outcome.kind === "transient")
    return { kind: "transient", error: outcome.error };
  if (outcome.kind === "empty")
    return { kind: "no_data", provider: "google_books" };
  const desc = outcome.value.volumeInfo?.description;
  if (desc && LIBRARY_STUB_RE.test(desc))
    return { kind: "empty", provider: "google_books" };
  if (!desc) return { kind: "empty", provider: "google_books" };
  return {
    kind: "success",
    value: stripMarketingCruft(desc),
    provider: "google_books",
  };
}

export function classifyDescriptionFromItunes(
  state: ItunesDescriptionState,
): LegOutcome<string> {
  if (!state.hasIsbn) return { kind: "disabled" };
  const { outcome } = state;
  if (outcome.kind === "rate_limited") return { kind: "rate_limited" };
  if (outcome.kind === "transient")
    return { kind: "transient", error: outcome.error };
  if (outcome.kind === "empty") return { kind: "no_data", provider: "itunes" };
  const desc = outcome.value.description;
  if (!desc) return { kind: "empty", provider: "itunes" };
  return { kind: "success", value: desc, provider: "itunes" };
}

// ── publisher ────────────────────────────────────────────────────────────────

export function classifyPublisherFromOpenLibrary(
  olData: OpenLibraryDataDoc | null,
): LegOutcome<string> {
  if (olData == null) return { kind: "no_data", provider: "openlibrary" };
  // Multi-imprint / co-publisher OL records (academic editions, translations)
  // carry every publisher name in `publishers[]`. Pre-refit
  // `extractOpenLibraryMetadata` joined them with ", "; match that so a
  // record like Penguin + Random House persists as "Penguin, Random House"
  // rather than just the first entry.
  const names = (olData.publishers ?? [])
    .map((p) => p.name)
    .filter((n): n is string => !!n);
  if (names.length === 0) return { kind: "empty", provider: "openlibrary" };
  return { kind: "success", value: names.join(", "), provider: "openlibrary" };
}

export function classifyPublisherFromGoogleBooks(
  state: GbState,
): LegOutcome<string> {
  if (!state.apiKeySet) return { kind: "disabled" };
  const { outcome } = state;
  if (outcome.kind === "rate_limited") return { kind: "rate_limited" };
  if (outcome.kind === "transient")
    return { kind: "transient", error: outcome.error };
  if (outcome.kind === "empty")
    return { kind: "no_data", provider: "google_books" };
  const v = outcome.value.volumeInfo?.publisher;
  if (!v) return { kind: "empty", provider: "google_books" };
  return { kind: "success", value: v, provider: "google_books" };
}

// ── published_date ───────────────────────────────────────────────────────────

export function classifyPublishedDateFromOpenLibrary(
  olData: OpenLibraryDataDoc | null,
): LegOutcome<string> {
  if (olData == null) return { kind: "no_data", provider: "openlibrary" };
  const v = olData.publish_date;
  if (!v) return { kind: "empty", provider: "openlibrary" };
  return { kind: "success", value: v, provider: "openlibrary" };
}

export function classifyPublishedDateFromGoogleBooks(
  state: GbState,
): LegOutcome<string> {
  if (!state.apiKeySet) return { kind: "disabled" };
  const { outcome } = state;
  if (outcome.kind === "rate_limited") return { kind: "rate_limited" };
  if (outcome.kind === "transient")
    return { kind: "transient", error: outcome.error };
  if (outcome.kind === "empty")
    return { kind: "no_data", provider: "google_books" };
  const v = outcome.value.volumeInfo?.publishedDate;
  if (!v) return { kind: "empty", provider: "google_books" };
  return { kind: "success", value: v, provider: "google_books" };
}

// ── page_count ───────────────────────────────────────────────────────────────

export function classifyPageCountFromOpenLibrary(
  olData: OpenLibraryDataDoc | null,
): LegOutcome<number> {
  if (olData == null) return { kind: "no_data", provider: "openlibrary" };
  const v = olData.number_of_pages;
  if (v == null || v <= 0) return { kind: "empty", provider: "openlibrary" };
  return { kind: "success", value: v, provider: "openlibrary" };
}

export function classifyPageCountFromGoogleBooks(
  state: GbState,
): LegOutcome<number> {
  if (!state.apiKeySet) return { kind: "disabled" };
  const { outcome } = state;
  if (outcome.kind === "rate_limited") return { kind: "rate_limited" };
  if (outcome.kind === "transient")
    return { kind: "transient", error: outcome.error };
  if (outcome.kind === "empty")
    return { kind: "no_data", provider: "google_books" };
  const v = outcome.value.volumeInfo?.pageCount;
  if (v == null || v <= 0) return { kind: "empty", provider: "google_books" };
  return { kind: "success", value: v, provider: "google_books" };
}

// ── subjects (union OL.subjects ⨁ OL.work.subjects, then GB categories) ─────

// Cap OL subjects at 30 entries to match pre-refit
// `extractOpenLibraryMetadata` behaviour. MARC-derived bibliographies on
// OL sometimes return hundreds of subjects; book_catalog.subjects is a
// text[] with no hard cap, but the feed-card chip rows truncate visually
// and 30+ subjects bloat the row payload on every read.
const OL_SUBJECTS_CAP = 30;

export function classifySubjectsFromOpenLibrary(
  olData: OpenLibraryDataDoc | null,
  olWork: OpenLibraryWork | null,
): LegOutcome<string[]> {
  if (olData == null && olWork == null)
    return { kind: "no_data", provider: "openlibrary" };
  const fromData = (olData?.subjects ?? [])
    .map((s) => (typeof s === "string" ? s : s.name))
    .filter((s): s is string => !!s);
  const fromWork = olWork?.subjects ?? [];
  const merged = Array.from(new Set([...fromData, ...fromWork])).slice(
    0,
    OL_SUBJECTS_CAP,
  );
  if (merged.length === 0) return { kind: "empty", provider: "openlibrary" };
  return { kind: "success", value: merged, provider: "openlibrary" };
}

export function classifySubjectsFromGoogleBooks(
  state: GbState,
): LegOutcome<string[]> {
  if (!state.apiKeySet) return { kind: "disabled" };
  const { outcome } = state;
  if (outcome.kind === "rate_limited") return { kind: "rate_limited" };
  if (outcome.kind === "transient")
    return { kind: "transient", error: outcome.error };
  if (outcome.kind === "empty")
    return { kind: "no_data", provider: "google_books" };
  const v = outcome.value.volumeInfo?.categories;
  if (!v?.length) return { kind: "empty", provider: "google_books" };
  return { kind: "success", value: v, provider: "google_books" };
}
