import type { SupabaseClient } from "@supabase/supabase-js";

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

export interface ResponseTransfer {
  id: string;
  filename: string;
  fileSize: number;
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
      if (
        typeof hl.chapter !== "number" ||
        hl.chapter < 0 ||
        !Number.isInteger(hl.chapter) ||
        hl.chapter > 32767
      ) {
        return {
          error: "Highlight chapter must be a non-negative integer up to 32767",
        };
      }
      if (
        typeof hl.startWord !== "number" ||
        hl.startWord < 0 ||
        !Number.isInteger(hl.startWord) ||
        hl.startWord > 2_147_483_647
      ) {
        return {
          error: "Highlight startWord must be a non-negative integer",
        };
      }
      if (
        typeof hl.endWord !== "number" ||
        !Number.isInteger(hl.endWord) ||
        hl.endWord <= (hl.startWord as number) ||
        hl.endWord > 2_147_483_647
      ) {
        return { error: "Highlight endWord must be greater than startWord" };
      }
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
              typeof n !== "number" ||
              !Number.isInteger(n) ||
              (n as number) < 0,
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
        if (
          typeof dl.chapter !== "number" ||
          dl.chapter < 0 ||
          !Number.isInteger(dl.chapter) ||
          dl.chapter > 32767
        ) {
          return {
            error:
              "Deleted highlight chapter must be a non-negative integer up to 32767",
          };
        }
        if (
          typeof dl.startWord !== "number" ||
          dl.startWord < 0 ||
          !Number.isInteger(dl.startWord) ||
          dl.startWord > 2_147_483_647
        ) {
          return {
            error: "Deleted highlight startWord must be a non-negative integer",
          };
        }
        if (
          typeof dl.endWord !== "number" ||
          !Number.isInteger(dl.endWord) ||
          dl.endWord <= (dl.startWord as number) ||
          dl.endWord > 2_147_483_647
        ) {
          return {
            error: "Deleted highlight endWord must be greater than startWord",
          };
        }
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
        deleted_at: null,
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
      await Promise.all(
        allDeletes.map(async (del) => {
          const { error: delError } = await supabase
            .from("highlights")
            .update({ deleted_at: nowIso })
            .eq("book_id", del.bookId)
            .eq("chapter_index", del.chapter)
            .eq("start_word", del.startWord)
            .eq("end_word", del.endWord)
            .is("deleted_at", null);

          if (delError) {
            throw new Error(
              `Failed to soft-delete highlight: ${delError.message}`,
            );
          }
        }),
      );
    }
  }

  // 2. Query notes, deleted highlights, and pending transfers in parallel
  const [noteResult, deletedResult, transferResult, failedCountResult] =
    await Promise.all([
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
        .is("highlights.deleted_at", null),

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
        .gt("updated_at", lastSynced),

      supabase
        .from("book_transfers")
        .select("id, filename, file_size")
        .eq("user_id", userId)
        .eq("status", "pending")
        .or(`device_id.eq.${deviceId},device_id.is.null`),

      supabase
        .from("book_transfers")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "failed"),
    ]);

  if (noteResult.error) {
    throw new Error(`Failed to fetch notes: ${noteResult.error.message}`);
  }
  if (deletedResult.error) {
    throw new Error(
      `Failed to fetch deleted highlights: ${deletedResult.error.message}`,
    );
  }
  if (transferResult.error) {
    throw new Error(
      `Failed to fetch transfers: ${transferResult.error.message}`,
    );
  }

  const notes: ResponseNote[] = (
    (noteResult.data ?? []) as unknown as NoteRow[]
  ).map((n) => ({
    bookHash: n.highlights.books.book_hash,
    chapter: n.highlights.chapter_index,
    startWord: n.highlights.start_word,
    endWord: n.highlights.end_word,
    note: n.text,
    updatedAt: n.updated_at,
  }));

  const deletedHighlights: ResponseDeletedHighlight[] = (
    (deletedResult.data ?? []) as unknown as DeletedHighlightRow[]
  ).map((h) => ({
    bookHash: h.books.book_hash,
    chapter: h.chapter_index,
    startWord: h.start_word,
    endWord: h.end_word,
  }));

  const pendingTransfers: ResponseTransfer[] = (
    (transferResult.data as TransferRow[] | null) ?? []
  ).map((t) => ({
    id: t.id,
    filename: t.filename,
    fileSize: t.file_size,
  }));

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
    failedTransferCount =
      (failedCountResult as unknown as { count?: number }).count ?? 0;
  }

  return {
    syncedAt,
    notes,
    deletedHighlights,
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

interface TransferRow {
  id: string;
  filename: string;
  file_size: number;
}
