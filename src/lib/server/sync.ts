import type { SupabaseClient } from "@supabase/supabase-js";
import { SYNC_DOWNLOAD_URL_TTL } from "./transfer";

// --- Incoming payload types (device → server) ---

export interface SyncPayload {
  lastSyncedAt: number;
  books: SyncBook[];
}

export interface SyncBook {
  bookHash: string;
  title?: string;
  author?: string;
  isbn?: string;
  language?: string;
  highlights: SyncHighlight[];
  deletedHighlights?: DeletedHighlightRef[];
}

export interface SyncHighlight {
  chapter: number;
  startWord: number;
  endWord: number;
  text: string;
  chapterTitle?: string;
  styles?: string;
  paragraphBreaks?: number[];
  timestamp?: number;
}

export interface DeletedHighlightRef {
  chapter: number;
  startWord: number;
  endWord: number;
}

// --- Response types (server → device) ---

export interface SyncResponse {
  syncedAt: number;
  notes: ResponseNote[];
  deletedHighlights: ResponseDeletedHighlight[];
  deletedNotes: ResponseDeletedNote[];
  pendingTransfers: ResponseTransfer[];
  failedTransferCount: number;
}

export interface ResponseNote {
  bookHash: string;
  chapter: number;
  startWord: number;
  endWord: number;
  note: string;
  updatedAt: string;
}

export interface ResponseDeletedHighlight {
  bookHash: string;
  chapter: number;
  startWord: number;
  endWord: number;
}

export interface ResponseDeletedNote {
  bookHash: string;
  chapter: number;
  startWord: number;
  endWord: number;
}

export interface ResponseTransfer {
  id: string;
  filename: string;
  fileSize: number;
  /**
   * Signed download URL for the stored EPUB. Atomic triplet with `sha256` and
   * `urlExpiresIn`: all three present on URL-gen success, all three absent on
   * URL-gen failure (device falls back to GET /api/transfer/[id]/download-url).
   */
  downloadUrl?: string;
  /** Lowercase 64-hex SHA-256 of the stored object. See `downloadUrl`. */
  sha256?: string;
  /** Seconds until `downloadUrl` expires, measured from sync-response issue time. See `downloadUrl`. */
  urlExpiresIn?: number;
}

// --- Validation ---

const MAX_METADATA_LEN = 1_000;
const MAX_TEXT_LEN = 10_000;
const MAX_STYLES_LEN = 2_000;

function exceedsLength(
  obj: Record<string, unknown>,
  field: string,
  max: number,
): boolean {
  return typeof obj[field] === "string" && (obj[field] as string).length > max;
}

// Per-row range guard for highlights & deletedHighlights. Bounds match
// Postgres column types. endWord >= startWord allows single-word highlights.
function validateRange(
  obj: Record<string, unknown>,
  label: "Highlight" | "Deleted highlight",
): string | null {
  if (
    typeof obj.chapter !== "number" ||
    obj.chapter < 0 ||
    !Number.isInteger(obj.chapter) ||
    obj.chapter > 32767
  ) {
    return `${label} chapter must be a non-negative integer up to 32767`;
  }
  if (
    typeof obj.startWord !== "number" ||
    obj.startWord < 0 ||
    !Number.isInteger(obj.startWord) ||
    obj.startWord > 2_147_483_647
  ) {
    return `${label} startWord must be a non-negative integer`;
  }
  if (
    typeof obj.endWord !== "number" ||
    !Number.isInteger(obj.endWord) ||
    obj.endWord < 0 ||
    obj.endWord < obj.startWord ||
    obj.endWord > 2_147_483_647
  ) {
    return `${label} endWord must be an integer in [startWord, 2147483647]`;
  }
  return null;
}

export function validateSyncPayload(
  body: unknown,
): { payload: SyncPayload } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object" };
  }

  const { lastSyncedAt, books } = body as Record<string, unknown>;

  if (
    typeof lastSyncedAt !== "number" ||
    lastSyncedAt < 0 ||
    !Number.isInteger(lastSyncedAt)
  ) {
    return { error: "lastSyncedAt must be a non-negative integer" };
  }

  if (!Array.isArray(books)) {
    return { error: "books must be an array" };
  }

  if (books.length > 50) {
    return { error: "books array must not exceed 50 entries" };
  }

  let totalHighlights = 0;
  const seenHashes = new Set<string>();

  for (const book of books) {
    if (!book || typeof book !== "object") {
      return { error: "Each book must be an object" };
    }

    const b = book as Record<string, unknown>;
    if (typeof b.bookHash !== "string" || !/^[0-9a-f]{8}$/.test(b.bookHash)) {
      return { error: "Each book must have a valid bookHash (8 hex chars)" };
    }

    if (seenHashes.has(b.bookHash)) {
      return { error: "Duplicate bookHash in books array" };
    }
    seenHashes.add(b.bookHash);

    if (
      exceedsLength(b, "title", MAX_METADATA_LEN) ||
      exceedsLength(b, "author", MAX_METADATA_LEN) ||
      exceedsLength(b, "isbn", MAX_METADATA_LEN) ||
      exceedsLength(b, "language", MAX_METADATA_LEN)
    ) {
      return { error: "Book metadata fields must not exceed 1000 characters" };
    }

    if (!Array.isArray(b.highlights)) {
      return { error: "Each book must have a highlights array" };
    }

    if (b.highlights.length > 500) {
      return { error: "Each book must not exceed 500 highlights" };
    }

    totalHighlights += b.highlights.length;
    if (totalHighlights > 2000) {
      return {
        error: "Total highlights across all books must not exceed 2000",
      };
    }

    for (const h of b.highlights) {
      if (!h || typeof h !== "object") {
        return { error: "Each highlight must be an object" };
      }
      const hl = h as Record<string, unknown>;
      const rangeError = validateRange(hl, "Highlight");
      if (rangeError) return { error: rangeError };
      if (
        typeof hl.text !== "string" ||
        hl.text.length === 0 ||
        hl.text.length > MAX_TEXT_LEN
      ) {
        return {
          error:
            "Highlight text must be a non-empty string up to 10000 characters",
        };
      }
      if (exceedsLength(hl, "chapterTitle", MAX_METADATA_LEN)) {
        return {
          error: "Highlight chapterTitle must not exceed 1000 characters",
        };
      }
      if (exceedsLength(hl, "styles", MAX_STYLES_LEN)) {
        return {
          error: "Highlight styles must not exceed 2000 characters",
        };
      }
      if (hl.paragraphBreaks !== undefined) {
        if (
          !Array.isArray(hl.paragraphBreaks) ||
          hl.paragraphBreaks.length > 1000
        ) {
          return {
            error: "paragraphBreaks must be an array of at most 1000 entries",
          };
        }
        if (
          hl.paragraphBreaks.some(
            (n: unknown) =>
              typeof n !== "number" || !Number.isInteger(n) || n < 0,
          )
        ) {
          return {
            error: "paragraphBreaks entries must be non-negative integers",
          };
        }
      }
      if (
        hl.timestamp !== undefined &&
        (typeof hl.timestamp !== "number" ||
          !Number.isInteger(hl.timestamp) ||
          hl.timestamp < 0)
      ) {
        return {
          error: "Highlight timestamp must be a non-negative integer",
        };
      }
    }

    if (b.deletedHighlights !== undefined) {
      if (!Array.isArray(b.deletedHighlights)) {
        return { error: "deletedHighlights must be an array" };
      }
      if (b.deletedHighlights.length > 500) {
        return {
          error: "Each book must not exceed 500 deleted highlight refs",
        };
      }
      for (const d of b.deletedHighlights) {
        if (!d || typeof d !== "object") {
          return { error: "Each deleted highlight must be an object" };
        }
        const dl = d as Record<string, unknown>;
        const rangeError = validateRange(dl, "Deleted highlight");
        if (rangeError) return { error: rangeError };
      }
    }
  }

  return { payload: body as SyncPayload };
}

// --- Business logic ---

export async function processSync(
  supabase: SupabaseClient,
  deviceId: string,
  userId: string,
  payload: SyncPayload,
): Promise<SyncResponse> {
  const now = new Date();
  const syncedAt = Math.floor(now.getTime() / 1000);
  const nowIso = now.toISOString();
  const lastSynced = new Date(payload.lastSyncedAt * 1000).toISOString();

  // 1. Batch-upsert all books, highlights, and process deletes
  if (payload.books.length > 0) {
    const bookRows = payload.books.map((book) => ({
      user_id: userId,
      book_hash: book.bookHash,
      title: book.title ?? null,
      author: book.author ?? null,
      isbn: book.isbn ?? null,
      language: book.language ?? null,
    }));

    const { data: upsertedBooks, error: bookError } = await supabase
      .from("books")
      .upsert(bookRows, { onConflict: "user_id,book_hash" })
      .select("id, book_hash");

    if (bookError || !upsertedBooks) {
      throw new Error(`Failed to upsert books: ${bookError?.message}`);
    }

    const hashToId = new Map<string, string>(
      (upsertedBooks as { id: string; book_hash: string }[]).map((r) => [
        r.book_hash,
        r.id,
      ]),
    );

    // Batch-upsert all highlights across all books
    const allHighlightRows = payload.books.flatMap((book) => {
      const bookId = hashToId.get(book.bookHash);
      if (!bookId) {
        throw new Error(`Book ${book.bookHash} missing from upsert result`);
      }
      return book.highlights.map((h) => ({
        book_id: bookId,
        user_id: userId,
        chapter_index: h.chapter,
        start_word: h.startWord,
        end_word: h.endWord,
        text: h.text,
        chapter_title: h.chapterTitle ?? null,
        styles: h.styles ?? null,
        paragraph_breaks: h.paragraphBreaks ?? null,
        device_timestamp_raw: h.timestamp ?? null,
        // deleted_at intentionally omitted — server owns this column.
        // Including it would resurrect server-side soft-deletes when a
        // not-yet-synced device sends back the same highlight.
      }));
    });

    if (allHighlightRows.length > 0) {
      const { error: hlError } = await supabase
        .from("highlights")
        .upsert(allHighlightRows, {
          onConflict: "book_id,chapter_index,start_word,end_word",
        });

      if (hlError) {
        throw new Error(`Failed to upsert highlights: ${hlError.message}`);
      }
    }

    // Soft-delete highlights the device marked as deleted
    const allDeletes = payload.books.flatMap((book) => {
      const bookId = hashToId.get(book.bookHash);
      if (!bookId) {
        throw new Error(`Book ${book.bookHash} missing from upsert result`);
      }
      return (book.deletedHighlights ?? []).map((del) => ({
        bookId,
        chapter: del.chapter,
        startWord: del.startWord,
        endWord: del.endWord,
      }));
    });

    if (allDeletes.length > 0) {
      // Batched soft-delete via Postgres RPC. The previous shape fired one
      // round-trip UPDATE per deleted highlight in a Promise.all loop —
      // capped at 25,000 statements per request worst case (500 deletes
      // × 50 books). soft_delete_highlights collapses the whole set into
      // one statement. See migration 20260430000005 and audit issue P1.
      const rows = allDeletes.map((del) => ({
        book_id: del.bookId,
        chapter: del.chapter,
        start_word: del.startWord,
        end_word: del.endWord,
      }));

      const { error: delError } = await supabase.rpc("soft_delete_highlights", {
        p_user_id: userId,
        p_now: nowIso,
        p_rows: rows,
      });

      if (delError) {
        throw new Error(
          `Failed to soft-delete highlights: ${delError.message}`,
        );
      }
    }
  }

  // 2. Query notes, deleted highlights, and pending transfers in parallel.
  //
  // Join queries on `notes!inner` / `books!inner` resolve to nested objects at
  // runtime (`n.highlights.books.book_hash`) but PostgREST's generic inference
  // widens them to arrays without a generated `Database` type. We use
  // `.overrideTypes<XRow[], { merge: false }>()` — Supabase's first-class type
  // override — to bind each query's `.data` to the runtime shape declared
  // below. This eliminates the `as unknown as XRow[]` casts at the use sites
  // and keeps the count-query `.count` accessor on a properly typed envelope.
  // Replace once L6 ships generated types via `supabase gen types typescript`.
  const transferReadPromise = supabase
    .from("book_transfers")
    .select("id, filename, file_size, storage_path, sha256")
    .eq("user_id", userId)
    .eq("status", "pending")
    // deviceId UUID-validated at auth boundary; do NOT pass user-controlled identifiers to .or() filters without validation.
    .or(`device_id.eq.${deviceId},device_id.is.null`)
    .overrideTypes<TransferRow[], { merge: false }>();

  // kicks off signed-URL fan-out as soon as transfers land, in parallel with the other read-phase queries.
  const urlsPromise = transferReadPromise.then(async (result) => {
    if (result.error) {
      return {
        result,
        urls: [] as PromiseSettledResult<
          Awaited<
            ReturnType<
              ReturnType<typeof supabase.storage.from>["createSignedUrl"]
            >
          >
        >[],
      };
    }
    const rows = result.data ?? [];
    const urls = await Promise.allSettled(
      rows.map((t) =>
        supabase.storage
          .from("book-transfers")
          .createSignedUrl(t.storage_path, SYNC_DOWNLOAD_URL_TTL),
      ),
    );
    return { result, urls };
  });

  const [
    noteResult,
    deletedNotesResult,
    deletedResult,
    transferAndUrls,
    failedCountResult,
  ] = await Promise.all([
    supabase
      .from("notes")
      .select(
        `
        text,
        updated_at,
        highlights!inner (
          chapter_index,
          start_word,
          end_word,
          books!inner (book_hash)
        )
      `,
      )
      .eq("user_id", userId)
      .gt("updated_at", lastSynced)
      .is("deleted_at", null)
      .is("highlights.deleted_at", null)
      .overrideTypes<NoteRow[], { merge: false }>(),

    supabase
      .from("notes")
      .select(
        `
        updated_at,
        highlights!inner (
          chapter_index,
          start_word,
          end_word,
          books!inner (book_hash)
        )
      `,
      )
      .eq("user_id", userId)
      .gt("updated_at", lastSynced)
      .not("deleted_at", "is", null)
      .overrideTypes<DeletedNoteRow[], { merge: false }>(),

    supabase
      .from("highlights")
      .select(
        `
        chapter_index,
        start_word,
        end_word,
        books!inner (book_hash)
      `,
      )
      .eq("user_id", userId)
      .not("deleted_at", "is", null)
      .gt("updated_at", lastSynced)
      .overrideTypes<DeletedHighlightRow[], { merge: false }>(),

    urlsPromise,

    supabase
      .from("book_transfers")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "failed"),
  ]);

  const transferResult = transferAndUrls.result;
  const urlResults = transferAndUrls.urls;

  if (noteResult.error) {
    throw new Error(`Failed to fetch notes: ${noteResult.error.message}`);
  }
  if (deletedResult.error) {
    throw new Error(
      `Failed to fetch deleted highlights: ${deletedResult.error.message}`,
    );
  }
  if (deletedNotesResult.error) {
    throw new Error(
      `Failed to fetch deleted notes: ${deletedNotesResult.error.message}`,
    );
  }
  if (transferResult.error) {
    throw new Error(
      `Failed to fetch transfers: ${transferResult.error.message}`,
    );
  }

  const notes: ResponseNote[] = (noteResult.data ?? []).map((n) => ({
    bookHash: n.highlights.books.book_hash,
    chapter: n.highlights.chapter_index,
    startWord: n.highlights.start_word,
    endWord: n.highlights.end_word,
    note: n.text,
    updatedAt: n.updated_at,
  }));

  const deletedHighlights: ResponseDeletedHighlight[] = (
    deletedResult.data ?? []
  ).map((h) => ({
    bookHash: h.books.book_hash,
    chapter: h.chapter_index,
    startWord: h.start_word,
    endWord: h.end_word,
  }));

  const deletedNotes: ResponseDeletedNote[] = (
    deletedNotesResult.data ?? []
  ).map((n) => ({
    bookHash: n.highlights.books.book_hash,
    chapter: n.highlights.chapter_index,
    startWord: n.highlights.start_word,
    endWord: n.highlights.end_word,
  }));

  const transferRows = transferResult.data ?? [];

  const pendingTransfers: ResponseTransfer[] = transferRows.map((t, i) => {
    const urlResult = urlResults[i];
    const base: ResponseTransfer = {
      id: t.id,
      filename: t.filename,
      fileSize: t.file_size,
    };

    if (urlResult.status === "fulfilled" && urlResult.value.data?.signedUrl) {
      return {
        ...base,
        downloadUrl: urlResult.value.data.signedUrl,
        sha256: t.sha256,
        urlExpiresIn: SYNC_DOWNLOAD_URL_TTL,
      };
    }

    console.warn("transfer_url_gen_failed", {
      transferId: t.id,
      storagePath: t.storage_path,
      error:
        urlResult.status === "rejected"
          ? String(urlResult.reason)
          : (urlResult.value.error?.message ?? "unknown"),
    });
    return base;
  });

  // 3. Update device timestamps
  const { error: deviceUpdateError } = await supabase
    .from("devices")
    .update({
      last_synced_at: nowIso,
      last_used_at: nowIso,
    })
    .eq("id", deviceId);

  if (deviceUpdateError) {
    throw new Error(
      `Failed to update device timestamps: ${deviceUpdateError.message}`,
    );
  }

  let failedTransferCount = 0;
  if (failedCountResult.error) {
    console.error(
      `Failed to fetch failedTransferCount: ${failedCountResult.error.message}`,
    );
  } else {
    failedTransferCount = failedCountResult.count ?? 0;
  }

  return {
    syncedAt,
    notes,
    deletedHighlights,
    deletedNotes,
    pendingTransfers,
    failedTransferCount,
  };
}

// --- Internal row types for DB join results ---

interface NoteRow {
  text: string;
  updated_at: string;
  highlights: {
    chapter_index: number;
    start_word: number;
    end_word: number;
    books: { book_hash: string };
  };
}

interface DeletedHighlightRow {
  chapter_index: number;
  start_word: number;
  end_word: number;
  books: { book_hash: string };
}

interface DeletedNoteRow {
  updated_at: string;
  highlights: {
    chapter_index: number;
    start_word: number;
    end_word: number;
    books: { book_hash: string };
  };
}

/**
 * Internal shape of a pending book_transfers row as consumed by processSync.
 * `storage_path` and `sha256` are projected by the SELECT at the transfers query
 * (see Task 3 of WS-B); the `WHERE status='pending'` predicate plus the WS-A
 * `valid_sha256` CHECK guarantee both are non-null on every returned row.
 */
interface TransferRow {
  id: string;
  filename: string;
  file_size: number;
  storage_path: string;
  sha256: string;
}
