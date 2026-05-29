// E2E catalog render-gate seeder (librito-io/web#431).
//
// The render gate proves a catalog-populated book renders its cover +
// description to the user. It does NOT re-test the resolver — resolver
// parsing is owned by the unit suite (mock fetchFn) and the field-state
// integration suite. So this helper seeds known-good `book_catalog` rows
// directly via the admin client and uploads a committed cover image to the
// local Supabase `cover-cache` bucket. No live OL/GB/iTunes, no resolver,
// no `$lib`/`$env` import (Playwright runs specs in plain Node, where the
// SvelteKit `$env/*` virtual modules the resolver pulls in cannot resolve).
//
// Fixtures are chosen by RENDER SHAPE, not by book:
//   - isbn-full     ISBN-keyed, full metadata + cover
//   - ta-full       title/author-keyed (no ISBN), full metadata + cover
//   - isbn-partial  no cover, no description → graceful-degradation path
//
// Titles/ISBNs reuse real books from the refit acceptance list; the
// metadata strings are hand-authored (the resolver is not consulted).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAdmin } from "./supabase";

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
const COVER_BYTES = readFileSync(join(HELPER_DIR, "../fixtures/cover.png"));
const COVER_BUCKET = "cover-cache";

// Inlined copy of normalizeTitleAuthor (src/lib/server/catalog/title-author.ts).
// MUST stay byte-identical to the app's normalization or the title/author
// catalog join silently misses and the cover renders as a placeholder. Kept
// inline because this helper runs in Playwright's plain-Node process where
// `$lib/server/catalog/*` cannot be imported.
function normalizeTitleAuthor(title: string, author: string): string {
  const strip = (s: string): string =>
    s
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]+/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return `${strip(title)}|${strip(author)}`;
}

export interface Fixture {
  title: string;
  author: string;
  /** Present → ISBN-keyed row; absent → title/author-keyed row. */
  isbn?: string;
  /** false → null storage (book-detail renders the placeholder asset). */
  cover: boolean;
  description: string | null;
  publisher: string | null;
  /** Stored as text; the page renders it verbatim in `.catalog-line`. */
  published_date: string | null;
  subjects: string[] | null;
  page_count: number | null;
}

// Identity helper: infers the literal key union (so `FixtureKey` stays the
// exact keys) while typing every value as the full `Fixture`. Without this,
// `as const`/`satisfies` would narrow each entry to its own literal type and
// `FIXTURES[key].isbn` would be invalid on the key union (the TA entry omits
// `isbn`). Here `isbn` reads as `string | undefined` on every entry.
function defineFixtures<K extends string>(
  f: Record<K, Fixture>,
): Record<K, Fixture> {
  return f;
}

export const FIXTURES = defineFixtures({
  "isbn-full": {
    title: "The Compound",
    author: "Aisling Rawle",
    isbn: "9780593977279",
    cover: true,
    description:
      "Lily wakes in a luxury compound in the desert, a contestant on a reality show with rules no one will explain.",
    publisher: "Random House",
    published_date: "2024",
    subjects: ["Fiction", "Thriller"],
    page_count: 336,
  },
  "ta-full": {
    title: "1984",
    author: "George Orwell",
    cover: true,
    description:
      "In a society under constant surveillance, Winston Smith dares to think for himself.",
    publisher: "Secker & Warburg",
    published_date: "1949",
    subjects: ["Fiction", "Dystopia"],
    page_count: 328,
  },
  "isbn-partial": {
    title: "Are You Mad at Me?",
    author: "Meg Josephson",
    isbn: "9781668082461",
    cover: false,
    description: null,
    publisher: null,
    published_date: null,
    subjects: null,
    page_count: null,
  },
});

export type FixtureKey = keyof typeof FIXTURES;

// ASCII-only storage key (Supabase `isValidKey` rejects non-ASCII — see
// memory note `supabase-storage-key-validator`).
function storagePathFor(key: FixtureKey): string {
  return `e2e/${key}.png`;
}

/**
 * Seed a `book_catalog` row for the named fixture and (when the fixture
 * carries a cover) upload the committed cover image to local Storage so the
 * derived public URL serves 200. Idempotent across reruns: deletes any prior
 * row for the same key before inserting. Catalog rows are shared per
 * ISBN/(title,author) — not user-scoped — so this is the cleanup boundary.
 */
export async function seedCatalogRow(key: FixtureKey): Promise<void> {
  const fix = FIXTURES[key];
  const admin = getAdmin();
  const storagePath = fix.cover ? storagePathFor(key) : null;

  if (storagePath) {
    const { error: upErr } = await admin.storage
      .from(COVER_BUCKET)
      .upload(storagePath, COVER_BYTES, {
        contentType: "image/png",
        upsert: true,
      });
    if (upErr) throw new Error(`seed cover upload: ${upErr.message}`);
  }

  const normalized = fix.isbn
    ? null
    : normalizeTitleAuthor(fix.title, fix.author);

  // Delete any prior row for this key (shared catalog state across reruns).
  if (fix.isbn) {
    await admin.from("book_catalog").delete().eq("isbn", fix.isbn);
  } else if (normalized) {
    await admin
      .from("book_catalog")
      .delete()
      .eq("normalized_title_author", normalized);
  }

  const { error } = await admin.from("book_catalog").insert({
    isbn: fix.isbn ?? null,
    normalized_title_author: normalized,
    title: fix.title,
    author: fix.author,
    description: fix.description,
    description_provider: fix.description ? "manual" : null,
    publisher: fix.publisher,
    published_date: fix.published_date,
    subjects: fix.subjects,
    page_count: fix.page_count,
    storage_path: storagePath,
    cover_storage_backend: storagePath ? "supabase" : null,
    cover_max_width: storagePath ? 1200 : null,
    cover_source: storagePath ? "manual" : null,
  });
  if (error) throw new Error(`seed book_catalog: ${error.message}`);
}
