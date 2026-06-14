import type { SupabaseClient } from "@supabase/supabase-js";
import { computeReconcile, RE_DRAG_GRACE_MS } from "./reconcile";
import type { ExistingHighlight } from "./reconcile";
import { logger } from "$lib/server/log";

// Kobo highlight import — Track 1, Issue 2 (librito-io/web#497).
//
// Separate write path from `processSync` (src/lib/server/sync.ts): Kobo
// highlights are char-offset / chapter-path based, not word-index based, so
// they cannot reuse the device's natural-key upsert. Imported rows carry NULL
// for chapter_index / start_word / end_word / styles / paragraph_breaks and
// render as plain quoted text. They share storage / feed / search / catalog
// downstream.
//
// Provenance schema landed in #496: `source` ('papers3'|'kobo'|'kindle') +
// nullable `source_uid`, with a partial unique index
// (book_id, source, source_uid) WHERE source_uid IS NOT NULL as the re-import
// idempotency anchor.

// --- Incoming payload types (agent → server) ---

export interface KoboImportItem {
  /** Kobo BookmarkID — stable per-highlight dedup key. Required. */
  source_uid: string;
  /** Highlighted text. Required, ≤ MAX_TEXT_LEN. */
  text: string;
  /** ISBN if the Kobo book carries one (store-bought); null for sideloads. */
  isbn?: string | null;
  /** Book title — required: the only cover signal when isbn is absent. */
  title: string;
  /** Book author — required: feeds the (title, author) catalog leg. */
  author: string;
  /** Kobo ContentID — stable key for book_hash synthesis on sideloads. */
  content_id: string;
  chapter_title?: string | null;
  /** ISO timestamp from Kobo, optional. */
  created_at?: string | null;
}

export interface KoboImportResult {
  imported: number;
  books: number;
  amended: number;
}

// --- Validation (mirrors the strictness of validateSyncPayload) ---

const MAX_TEXT_LEN = 10_000;
const MAX_METADATA_LEN = 1_000;
const MAX_SOURCE_UID_LEN = 200;
const MAX_CONTENT_ID_LEN = 1_000;
const MAX_ITEMS = 2_000;

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function isOptionalString(v: unknown, max: number): boolean {
  return (
    v === undefined || v === null || (typeof v === "string" && v.length <= max)
  );
}

/**
 * Validates and normalizes the import body. Accepts a bare array of items
 * (the issue's wire shape) or a `{ items: [...], complete?: boolean }` wrapper.
 * Returns the parsed items + completeness flag, or a single error string
 * (→ 400 at the route).
 *
 * `complete: true` means the agent asserts this is the user's entire Kobo set.
 * A bare array implies `complete=false` (back-compat). An empty `items` array
 * is accepted ONLY when `complete: true` (total-device wipe), so a wipe is
 * distinguishable from a buggy empty POST.
 */
export function validateKoboPayload(
  body: unknown,
): { items: KoboImportItem[]; complete: boolean } | { error: string } {
  let rawItems: unknown[] | null;
  let complete = false;
  if (Array.isArray(body)) {
    rawItems = body; // bare array ⇒ complete=false (back-compat)
  } else if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).items)
  ) {
    rawItems = (body as Record<string, unknown>).items as unknown[];
    const c = (body as Record<string, unknown>).complete;
    if (c !== undefined && typeof c !== "boolean") {
      return { error: "complete must be a boolean" };
    }
    complete = c === true;
  } else {
    rawItems = null;
  }

  if (!rawItems) {
    return { error: "Request body must be a JSON array of import items" };
  }
  // Empty set is a total-device wipe — accepted ONLY when completeness is
  // explicitly asserted, so a wipe is distinguishable from a buggy empty POST.
  if (rawItems.length === 0) {
    if (!complete) {
      return { error: "Import must contain at least one item" };
    }
    return { items: [], complete: true };
  }
  if (rawItems.length > MAX_ITEMS) {
    return { error: `Import must not exceed ${MAX_ITEMS} items` };
  }

  // Dedupe source_uid per book (content_id|isbn) so a single batch can't carry
  // two rows that would collide on the (book, source, source_uid) upsert key.
  const seen = new Set<string>();
  const items: KoboImportItem[] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: "Each import item must be an object" };
    }
    const it = raw as Record<string, unknown>;

    if (!isNonEmptyString(it.source_uid, MAX_SOURCE_UID_LEN)) {
      return {
        error: `Each item must have a non-empty source_uid (≤${MAX_SOURCE_UID_LEN} chars)`,
      };
    }
    if (!isNonEmptyString(it.text, MAX_TEXT_LEN)) {
      return {
        error: `Each item must have non-empty text up to ${MAX_TEXT_LEN} characters`,
      };
    }
    // title + author required: for a null-ISBN sideload they are the ONLY
    // catalog cover signal (drive the resolveTitleAuthor leg).
    if (!isNonEmptyString(it.title, MAX_METADATA_LEN)) {
      return {
        error: `Each item must have a title (≤${MAX_METADATA_LEN} chars)`,
      };
    }
    if (!isNonEmptyString(it.author, MAX_METADATA_LEN)) {
      return {
        error: `Each item must have an author (≤${MAX_METADATA_LEN} chars)`,
      };
    }

    const hasIsbn = isNonEmptyString(it.isbn, MAX_METADATA_LEN);
    // content_id is required when there is no ISBN — it is the book_hash source.
    if (!hasIsbn && !isNonEmptyString(it.content_id, MAX_CONTENT_ID_LEN)) {
      return {
        error: "Each item must have an isbn or a content_id for book identity",
      };
    }
    if (
      it.isbn !== undefined &&
      it.isbn !== null &&
      !isNonEmptyString(it.isbn, MAX_METADATA_LEN)
    ) {
      return { error: `isbn must be a string ≤${MAX_METADATA_LEN} chars` };
    }
    if (!isOptionalString(it.content_id, MAX_CONTENT_ID_LEN)) {
      return {
        error: `content_id must be a string ≤${MAX_CONTENT_ID_LEN} chars`,
      };
    }
    if (!isOptionalString(it.chapter_title, MAX_METADATA_LEN)) {
      return {
        error: `chapter_title must be a string ≤${MAX_METADATA_LEN} chars`,
      };
    }
    // created_at is optional, but when present must be a real parseable
    // timestamp — we forward it to the RPC as the highlight's origin time, so
    // an unparseable value would silently default to now() at the DB and the
    // agent author would get no signal.
    if (it.created_at !== undefined && it.created_at !== null) {
      if (
        typeof it.created_at !== "string" ||
        it.created_at.length > MAX_METADATA_LEN ||
        Number.isNaN(Date.parse(it.created_at))
      ) {
        return { error: "created_at must be a parseable ISO 8601 timestamp" };
      }
    }

    const bookKey = hasIsbn ? `isbn:${it.isbn}` : `cid:${it.content_id}`;
    const dedupKey = `${bookKey} ${it.source_uid}`;
    if (seen.has(dedupKey)) {
      return { error: "Duplicate source_uid within the same book in batch" };
    }
    seen.add(dedupKey);

    items.push({
      source_uid: it.source_uid as string,
      text: it.text as string,
      isbn: hasIsbn ? (it.isbn as string) : null,
      title: it.title as string,
      author: it.author as string,
      content_id: (it.content_id as string | null | undefined) ?? "",
      chapter_title: (it.chapter_title as string | null | undefined) ?? null,
      created_at: (it.created_at as string | null | undefined) ?? null,
    });
  }

  return { items, complete };
}

// --- book_hash synthesis ---

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit hash of `input`, lowercase 8-hex — satisfies the
 * `^[0-9a-f]{8}$` CHECK on books.book_hash. Same hash family as the device's
 * native EPUB hash. The catalog cover walker never reads book_hash, so a
 * synthesized value is invisible to cover discovery; it serves only per-user
 * book identity + the CHECK.
 */
export function fnv1a8Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV prime in 32-bit space (Math.imul) and coerce back to
    // unsigned with >>> 0.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deterministic 8-hex book_hash for a Kobo book. ISBN-namespaced when an ISBN
 * is present (one stable book per ISBN per user), else derived from the Kobo
 * ContentID for sideloads. Namespacing the ISBN path keeps it from colliding
 * with a content_id that happens to hash the same.
 */
export function synthesizeBookHash(opts: {
  isbn?: string | null;
  contentId?: string | null;
}): string {
  if (opts.isbn) return fnv1a8Hex(`isbn:${opts.isbn}`);
  return fnv1a8Hex(`cid:${opts.contentId ?? ""}`);
}

// --- Business logic ---

interface BookGroup {
  isbn: string | null;
  title: string;
  author: string;
  contentId: string;
  bookHash: string;
  items: KoboImportItem[];
}

function groupByBook(items: KoboImportItem[]): BookGroup[] {
  const groups = new Map<string, BookGroup>();
  for (const it of items) {
    const key = it.isbn ? `isbn:${it.isbn}` : `cid:${it.content_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        isbn: it.isbn ?? null,
        title: it.title,
        author: it.author,
        contentId: it.content_id,
        bookHash: synthesizeBookHash({
          isbn: it.isbn,
          contentId: it.content_id,
        }),
        items: [],
      };
      groups.set(key, g);
    }
    g.items.push(it);
  }
  return Array.from(groups.values());
}

/**
 * Import a batch of Kobo highlights for one user. All-or-nothing: any DB error
 * throws (→ 500 at the route) and the agent re-POSTs the full set — idempotent
 * via the (book_id, source, source_uid) partial unique index. Never trusts a
 * user_id from the payload; `userId` comes from the authenticated device token.
 */
export async function processKoboImport(
  supabase: SupabaseClient,
  userId: string,
  items: KoboImportItem[],
  complete: boolean = false,
): Promise<KoboImportResult> {
  const groups = groupByBook(items);

  // 1. Resolve each distinct book to a book_id.
  //
  // ISBN-first: reuse an existing per-user book with the same ISBN so a Kobo
  // import lands on the same row as (e.g.) a future PaperS3 copy and shares
  // catalog enrichment. Else upsert a synthesized-hash book.
  const bookKeyToId = new Map<string, string>();

  // Batch the ISBN lookups into one SELECT ... WHERE isbn = ANY(...) instead of
  // one round trip per book — a large multi-book import would otherwise be
  // O(N) sequential queries against the 1k-scale target.
  const isbns = Array.from(
    new Set(groups.map((g) => g.isbn).filter((v): v is string => !!v)),
  );
  const isbnToId = new Map<string, string>();
  if (isbns.length > 0) {
    const { data: existing, error: lookupErr } = await supabase
      .from("books")
      .select("id, isbn")
      .eq("user_id", userId)
      .in("isbn", isbns)
      .overrideTypes<{ id: string; isbn: string }[], { merge: false }>();
    if (lookupErr) {
      throw new Error(`Failed to look up books by isbn: ${lookupErr.message}`);
    }
    // A user could in principle have >1 row per ISBN today (no unique
    // constraint — convergence follow-up #500); first match wins, stable
    // because re-import reuses whichever row was picked.
    for (const row of existing ?? []) {
      if (!isbnToId.has(row.isbn)) isbnToId.set(row.isbn, row.id);
    }
  }

  for (const g of groups) {
    const key = g.isbn ? `isbn:${g.isbn}` : `cid:${g.contentId}`;

    if (g.isbn && isbnToId.has(g.isbn)) {
      bookKeyToId.set(key, isbnToId.get(g.isbn)!);
      continue;
    }

    // No ISBN match (or no ISBN at all): upsert by synthesized hash.
    const { data: upserted, error: bookErr } = await supabase
      .from("books")
      .upsert(
        {
          user_id: userId,
          book_hash: g.bookHash,
          title: g.title,
          author: g.author,
          isbn: g.isbn,
        },
        { onConflict: "user_id,book_hash" },
      )
      .select("id, book_hash")
      .overrideTypes<{ id: string; book_hash: string }[], { merge: false }>();
    if (bookErr || !upserted || upserted.length === 0) {
      throw new Error(`Failed to upsert book: ${bookErr?.message}`);
    }
    bookKeyToId.set(key, upserted[0].id);
  }

  // 2. Reconcile + write via the reconcile_kobo_highlights RPC.
  //
  // FULL-SET import (kobo-sync invariant #5): the agent re-POSTs the entire
  // highlight set every run. That is what makes "absent" meaningful — see
  // reconcile.ts. p_rows is the full batch; the matcher derives in-place
  // amends for span re-drags; the RPC also stamps first-observed removals.
  const highlightRows = groups.flatMap((g) => {
    const key = g.isbn ? `isbn:${g.isbn}` : `cid:${g.contentId}`;
    const bookId = bookKeyToId.get(key);
    if (!bookId) throw new Error(`Book ${key} missing from resolve result`);
    return g.items.map((it) => ({
      book_id: bookId,
      // user_id is NOT in the row payload — the RPC pins it from p_user_id.
      source_uid: it.source_uid,
      text: it.text,
      chapter_title: it.chapter_title ?? null,
      created_at: it.created_at ?? null,
    }));
  });

  // Empty incoming is a no-op UNLESS the agent asserts completeness — then it is
  // a total-device wipe and the RPC must still run STEP 3a stamp-only (spec
  // §4c). Returning here on empty+complete would silently skip the wipe stamp.
  if (highlightRows.length === 0 && !complete) {
    return { imported: 0, books: groups.length, amended: 0 };
  }

  const bookIds = Array.from(new Set(highlightRows.map((r) => r.book_id)));

  // Load the user's existing kobo rows for the covered books (live AND
  // trashed — trashed rows are amend candidates so trash intent survives a
  // span re-drag). source='kobo' scoping is load-bearing: a shared-ISBN book
  // can hold PaperS3 rows whose NULL source_uid would read as "absent".
  const { data: existingRows, error: exErr } = await supabase
    .from("highlights")
    .select(
      "id, book_id, source, source_uid, text, chapter_title, deleted_at, created_at, removed_from_device_at",
    )
    .eq("user_id", userId)
    .eq("source", "kobo")
    .in("book_id", bookIds)
    .overrideTypes<ExistingHighlight[], { merge: false }>();
  if (exErr) {
    throw new Error(
      `Failed to load existing kobo highlights: ${exErr.message}`,
    );
  }

  const incoming = highlightRows.map((r) => ({
    book_id: r.book_id,
    source_uid: r.source_uid,
    text: r.text,
    chapter_title: r.chapter_title,
  }));

  // One app-clock cutoff, shared by the matcher (candidacy) and the RPC
  // (amend precondition, p_cutoff). See RE_DRAG_GRACE_MS.
  const cutoff = new Date(Date.now() - RE_DRAG_GRACE_MS);

  const {
    amends,
    matchedAbsentCreatedAt,
    unmatchedAbsentCount,
    stampedTextMatches,
  } = computeReconcile(existingRows ?? [], incoming, cutoff);

  // One RPC: amends → upsert → stamps, plus the cross-book uid detector
  // (folded into the RPC so a full-set re-POST of up to MAX_ITEMS uids never
  // builds an unbounded .in("source_uid", …) URL — see the RPC's STEP 0).
  const { data: counts, error: rpcErr } = await supabase.rpc(
    "reconcile_kobo_highlights",
    {
      p_user_id: userId,
      p_rows: highlightRows,
      p_amends: amends,
      p_cutoff: cutoff.toISOString(),
      p_complete: complete,
    },
  );
  if (rpcErr) {
    throw new Error(`Failed to reconcile highlights: ${rpcErr.message}`);
  }
  const {
    amended = 0,
    stamped = 0,
    cleared = 0,
    cross_book_uid_hits: crossBookUidHits = 0,
  } = (counts ?? {}) as {
    amended: number;
    stamped: number;
    cleared: number;
    cross_book_uid_hits: number;
  };

  // Per-import structured line — instrumentation over fuzz (§8). Age is for
  // separating fresh re-drags from dedup-across-delete; NEVER a gate.
  const now = Date.now();
  logger().info(
    {
      event: "import.kobo.reconcile",
      books: groups.length,
      imported: highlightRows.length,
      amended,
      stamped,
      cleared,
      unmatchedAbsent: unmatchedAbsentCount,
      matchedAbsentAgeDays: matchedAbsentCreatedAt.map((c) =>
        Math.round((now - Date.parse(c)) / 86_400_000),
      ),
      crossBookUidHits,
      reDragGaps: stampedTextMatches.map((m) => ({
        gapMs: now - Date.parse(m.removedAt),
        decision: m.withinCutoff ? "amend_within_w" : "insert_beyond_w",
      })),
    },
    "import.kobo.reconcile",
  );

  return { imported: highlightRows.length, books: groups.length, amended };
}
