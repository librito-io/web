import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// Behaviour guard for migration 20260604000001 (highlight provenance —
// librito-io/web#496). Asserts the acceptance criteria that unit tests can't
// reach: backfill default, the papers3_requires_word_index CHECK, the two
// partial unique indexes (device natural key scoped to papers3, import dedup
// key scoped to source_uid), and that imported rows accept NULL word fields.
//
// Runs as superuser via direct Postgres; we exercise raw INSERTs (the importer
// in #497 uses the service-role client, which likewise bypasses RLS), so RLS
// is out of scope here.

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)("highlight source provenance (#496)", () => {
  const sql = getSql();
  let user: TestUser;
  let bookId: string;

  beforeAll(async () => {
    user = await createTestUser("highlight-provenance");
    const [book] = await sql<{ id: string }[]>`
      INSERT INTO public.books (user_id, book_hash, title, author, isbn)
      VALUES (${user.id}, ${"cafe1234"}, ${"Provenance Book"}, ${"Author"}, ${"9780000000001"})
      RETURNING id
    `;
    bookId = book.id;
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
    await shutdown();
  });

  it("backfills existing/native rows to source = 'papers3'", async () => {
    const [row] = await sql<{ id: string; source: string }[]>`
      INSERT INTO public.highlights
        (book_id, user_id, chapter_index, start_word, end_word, text)
      VALUES (${bookId}, ${user.id}, ${0}, ${0}, ${5}, ${"native row"})
      RETURNING id, source
    `;
    expect(row.source).toBe("papers3");
  });

  it("accepts a kobo row with NULL word fields and a non-null source_uid", async () => {
    const [row] = await sql<
      {
        source: string;
        chapter_index: number | null;
        start_word: number | null;
        end_word: number | null;
      }[]
    >`
      INSERT INTO public.highlights
        (book_id, user_id, source, source_uid, text)
      VALUES (${bookId}, ${user.id}, ${"kobo"}, ${"bookmark-uuid-1"}, ${"imported text"})
      RETURNING source, chapter_index, start_word, end_word
    `;
    expect(row.source).toBe("kobo");
    expect(row.chapter_index).toBeNull();
    expect(row.start_word).toBeNull();
    expect(row.end_word).toBeNull();
  });

  it("rejects a papers3 row with a NULL word field (papers3_requires_word_index)", async () => {
    // Typed null so the SQL-tag interpolation has a non-string operand type;
    // postgres-js still binds it as a real SQL NULL parameter.
    const nullStartWord: number | null = null;
    await expect(
      sql`
        INSERT INTO public.highlights
          (book_id, user_id, source, chapter_index, start_word, end_word, text)
        VALUES (${bookId}, ${user.id}, ${"papers3"}, ${0}, ${nullStartWord}, ${5}, ${"bad native row"})
      `,
    ).rejects.toThrow(/papers3_requires_word_index/);
  });

  it("rejects an unknown source (valid_highlight_source)", async () => {
    await expect(
      sql`
        INSERT INTO public.highlights
          (book_id, user_id, source, source_uid, text)
        VALUES (${bookId}, ${user.id}, ${"goodreads"}, ${"x"}, ${"bad source"})
      `,
    ).rejects.toThrow(/valid_highlight_source/);
  });

  it("collides two kobo rows sharing (book_id, source, source_uid)", async () => {
    await sql`
      INSERT INTO public.highlights
        (book_id, user_id, source, source_uid, text)
      VALUES (${bookId}, ${user.id}, ${"kobo"}, ${"dup-uid"}, ${"first"})
    `;
    await expect(
      sql`
        INSERT INTO public.highlights
          (book_id, user_id, source, source_uid, text)
        VALUES (${bookId}, ${user.id}, ${"kobo"}, ${"dup-uid"}, ${"second"})
      `,
    ).rejects.toThrow(/highlights_source_uid_key/);
  });

  it("still enforces the device natural key for papers3 rows (partial index)", async () => {
    await sql`
      INSERT INTO public.highlights
        (book_id, user_id, chapter_index, start_word, end_word, text)
      VALUES (${bookId}, ${user.id}, ${3}, ${10}, ${15}, ${"native A"})
    `;
    await expect(
      sql`
        INSERT INTO public.highlights
          (book_id, user_id, chapter_index, start_word, end_word, text)
        VALUES (${bookId}, ${user.id}, ${3}, ${10}, ${15}, ${"native dup"})
      `,
    ).rejects.toThrow(/highlights_device_natural_key/);
  });

  it("does NOT apply the device natural key across sources (same word coords, different source)", async () => {
    // A papers3 row and a kobo row could in principle share word coords; the
    // partial index WHERE source='papers3' must not collide them. (kobo rows
    // normally carry NULL word fields, but assert the scoping explicitly.)
    await sql`
      INSERT INTO public.highlights
        (book_id, user_id, source, source_uid, chapter_index, start_word, end_word, text)
      VALUES (${bookId}, ${user.id}, ${"kobo"}, ${"scoping-uid"}, ${3}, ${10}, ${15}, ${"kobo same coords"})
    `;
    // No throw == pass; the row above shares (3,10,15) with "native A" but is kobo.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.highlights
      WHERE book_id = ${bookId} AND chapter_index = 3 AND start_word = 10 AND end_word = 15
    `;
    expect(row.n).toBe(2); // one papers3, one kobo
  });

  it("created the idx_books_user_isbn partial index", async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_books_user_isbn'
    `;
    expect(row.n).toBe(1);
  });
});
