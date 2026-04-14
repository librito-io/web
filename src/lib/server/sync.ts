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

  for (const book of books) {
    if (!book || typeof book !== "object") {
      return { error: "Each book must be an object" };
    }

    const b = book as Record<string, unknown>;
    if (typeof b.bookHash !== "string" || !/^[0-9a-f]{8}$/.test(b.bookHash)) {
      return { error: "Each book must have a valid bookHash (8 hex chars)" };
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

    for (const h of b.highlights as Record<string, unknown>[]) {
      if (
        typeof h.chapter !== "number" ||
        h.chapter < 0 ||
        !Number.isInteger(h.chapter)
      ) {
        return { error: "Highlight chapter must be a non-negative integer" };
      }
      if (
        typeof h.startWord !== "number" ||
        h.startWord < 0 ||
        !Number.isInteger(h.startWord)
      ) {
        return { error: "Highlight startWord must be a non-negative integer" };
      }
      if (
        typeof h.endWord !== "number" ||
        !Number.isInteger(h.endWord) ||
        h.endWord <= (h.startWord as number)
      ) {
        return { error: "Highlight endWord must be greater than startWord" };
      }
      if (typeof h.text !== "string" || h.text.length === 0) {
        return { error: "Highlight text must be a non-empty string" };
      }
    }

    if (b.deletedHighlights !== undefined) {
      if (!Array.isArray(b.deletedHighlights)) {
        return { error: "deletedHighlights must be an array" };
      }
      for (const d of b.deletedHighlights as Record<string, unknown>[]) {
        if (
          typeof d.chapter !== "number" ||
          d.chapter < 0 ||
          !Number.isInteger(d.chapter)
        ) {
          return { error: "Deleted highlight chapter must be non-negative" };
        }
        if (
          typeof d.startWord !== "number" ||
          d.startWord < 0 ||
          !Number.isInteger(d.startWord)
        ) {
          return { error: "Deleted highlight startWord must be non-negative" };
        }
        if (
          typeof d.endWord !== "number" ||
          !Number.isInteger(d.endWord) ||
          d.endWord <= (d.startWord as number)
        ) {
          return {
            error: "Deleted highlight endWord must be greater than startWord",
          };
        }
      }
    }
  }

  return { payload: body as unknown as SyncPayload };
}

// --- Business logic ---

export async function processSync(
  supabase: SupabaseClient,
  deviceId: string,
  userId: string,
  payload: SyncPayload,
): Promise<SyncResponse> {
  const syncedAt = Math.floor(Date.now() / 1000);
  const lastSynced = new Date(payload.lastSyncedAt * 1000).toISOString();

  // 1. Upsert books and their highlights
  for (const book of payload.books) {
    const { data: bookRow, error: bookError } = await supabase
      .from("books")
      .upsert(
        {
          user_id: userId,
          book_hash: book.bookHash,
          title: book.title ?? null,
          author: book.author ?? null,
          isbn: book.isbn ?? null,
          language: book.language ?? null,
        },
        { onConflict: "user_id,book_hash" },
      )
      .select("id")
      .single();

    if (bookError || !bookRow) {
      throw new Error(
        `Failed to upsert book ${book.bookHash}: ${bookError?.message}`,
      );
    }

    // Upsert highlights (batch per book)
    if (book.highlights.length > 0) {
      const highlightRows = book.highlights.map((h) => ({
        book_id: bookRow.id,
        user_id: userId,
        chapter_index: h.chapter,
        start_word: h.startWord,
        end_word: h.endWord,
        text: h.text,
        chapter_title: h.chapterTitle ?? null,
        styles: h.styles ?? null,
        paragraph_breaks: h.paragraphBreaks ?? null,
        device_timestamp_raw: h.timestamp ?? null,
        deleted_at: null, // Clear soft-delete if device re-sends a previously deleted highlight
      }));

      const { error: hlError } = await supabase
        .from("highlights")
        .upsert(highlightRows, {
          onConflict: "book_id,chapter_index,start_word,end_word",
        });

      if (hlError) {
        throw new Error(`Failed to upsert highlights: ${hlError.message}`);
      }
    }

    // Soft-delete highlights the device marked as deleted
    for (const del of book.deletedHighlights ?? []) {
      await supabase
        .from("highlights")
        .update({ deleted_at: new Date().toISOString() })
        .eq("book_id", bookRow.id)
        .eq("chapter_index", del.chapter)
        .eq("start_word", del.startWord)
        .eq("end_word", del.endWord)
        .is("deleted_at", null);
    }
  }

  // 2. Query notes modified since lastSyncedAt (joined through highlights → books)
  const { data: noteRows } = await supabase
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
    .is("highlights.deleted_at", null);

  const notes: ResponseNote[] = ((noteRows as NoteRow[] | null) ?? []).map(
    (n) => ({
      bookHash: n.highlights.books.book_hash,
      chapter: n.highlights.chapter_index,
      startWord: n.highlights.start_word,
      endWord: n.highlights.end_word,
      note: n.text,
      updatedAt: n.updated_at,
    }),
  );

  // 3. Query highlights deleted (on web) since lastSyncedAt
  const { data: deletedRows } = await supabase
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
    .gt("updated_at", lastSynced);

  const deletedHighlights: ResponseDeletedHighlight[] = (
    (deletedRows as DeletedHighlightRow[] | null) ?? []
  ).map((h) => ({
    bookHash: h.books.book_hash,
    chapter: h.chapter_index,
    startWord: h.start_word,
    endWord: h.end_word,
  }));

  // 4. Query pending transfers for this device (or any-device transfers)
  const { data: transferRows } = await supabase
    .from("book_transfers")
    .select("id, filename, file_size")
    .eq("user_id", userId)
    .eq("status", "pending")
    .or(`device_id.eq.${deviceId},device_id.is.null`);

  const pendingTransfers: ResponseTransfer[] = (
    (transferRows as TransferRow[] | null) ?? []
  ).map((t) => ({
    id: t.id,
    filename: t.filename,
    fileSize: t.file_size,
  }));

  // 5. Update device timestamps
  await supabase
    .from("devices")
    .update({
      last_synced_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    })
    .eq("id", deviceId);

  return { syncedAt, notes, deletedHighlights, pendingTransfers };
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
