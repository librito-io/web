import type { SupabaseClient } from "@supabase/supabase-js";

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
 * (the issue's wire shape) or a `{ items: [...] }` wrapper. Returns the parsed
 * items or a single error string (→ 400 at the route).
 */
export function validateKoboPayload(
  body: unknown,
): { items: KoboImportItem[] } | { error: string } {
  let rawItems: unknown[] | null;
  if (Array.isArray(body)) {
    rawItems = body;
  } else if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).items)
  ) {
    rawItems = (body as Record<string, unknown>).items as unknown[];
  } else {
    rawItems = null;
  }

  if (!rawItems) {
    return { error: "Request body must be a JSON array of import items" };
  }
  if (rawItems.length === 0) {
    return { error: "Import must contain at least one item" };
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

  return { items };
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

  // 2. Batch-upsert highlights via the upsert_kobo_highlights RPC.
  //
  // The dedup key highlights_source_uid_key is a PARTIAL unique index
  // (WHERE source_uid IS NOT NULL); supabase-js `.upsert({ onConflict })`
  // cannot thread the partial predicate, so the conflict target must carry the
  // matching WHERE — which only the SQL function can express. The RPC forces
  // source='kobo', leaves word/style columns NULL, and omits deleted_at on
  // conflict (server owns soft-delete; no resurrection on re-import).
  const highlightRows = groups.flatMap((g) => {
    const key = g.isbn ? `isbn:${g.isbn}` : `cid:${g.contentId}`;
    const bookId = bookKeyToId.get(key);
    if (!bookId) throw new Error(`Book ${key} missing from resolve result`);
    return g.items.map((it) => ({
      book_id: bookId,
      // user_id is NOT in the row payload — the RPC pins it from p_user_id
      // server-side so a payload value can never bind a row to another user.
      source_uid: it.source_uid,
      text: it.text,
      chapter_title: it.chapter_title ?? null,
      created_at: it.created_at ?? null,
    }));
  });

  if (highlightRows.length > 0) {
    const { error: hlErr } = await supabase.rpc("upsert_kobo_highlights", {
      p_user_id: userId,
      p_rows: highlightRows,
    });
    if (hlErr) {
      throw new Error(`Failed to upsert highlights: ${hlErr.message}`);
    }
  }

  return { imported: highlightRows.length, books: groups.length };
}
