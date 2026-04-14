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

    for (const h of b.highlights as Record<string, unknown>[]) {
      if (typeof h.chapter !== "number" || h.chapter < 0) {
        return { error: "Highlight chapter must be a non-negative integer" };
      }
      if (typeof h.startWord !== "number" || h.startWord < 0) {
        return { error: "Highlight startWord must be a non-negative integer" };
      }
      if (
        typeof h.endWord !== "number" ||
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
        if (typeof d.chapter !== "number" || d.chapter < 0) {
          return { error: "Deleted highlight chapter must be non-negative" };
        }
        if (typeof d.startWord !== "number" || d.startWord < 0) {
          return { error: "Deleted highlight startWord must be non-negative" };
        }
        if (
          typeof d.endWord !== "number" ||
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
