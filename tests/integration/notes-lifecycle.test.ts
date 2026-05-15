import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// Tombstone semantics end-to-end: insert highlight + note, exercise the
// `get_highlight_feed` RPC, soft-delete the note, exercise again. Guards the
// migration pair 20260426000001 (notes.deleted_at column) +
// 20260426000002 (RPC filter) against a future regression that drops the
// `AND n.deleted_at IS NULL` clause in the RPC join.
//
// Tests run as superuser via direct Postgres; we explicitly set
// `request.jwt.claims` + ROLE inside a transaction so SECURITY INVOKER
// functions see the right `auth.uid()`. RLS itself isn't exercised here.

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)("notes lifecycle: tombstone filtering via RPC", () => {
  const sql = getSql();
  let user: TestUser;
  let bookId: string;
  let highlightId: string;
  let noteId: string;

  beforeAll(async () => {
    user = await createTestUser("notes-lifecycle");

    const [book] = await sql<{ id: string }[]>`
      INSERT INTO public.books (user_id, book_hash, title, author)
      VALUES (${user.id}, ${"deadbeef"}, ${"IT Test Book"}, ${"IT Author"})
      RETURNING id
    `;
    bookId = book.id;

    const [highlight] = await sql<{ id: string }[]>`
      INSERT INTO public.highlights
        (book_id, user_id, chapter_index, start_word, end_word, text)
      VALUES
        (${bookId}, ${user.id}, ${0}, ${0}, ${5}, ${"Integration test highlight"})
      RETURNING id
    `;
    highlightId = highlight.id;

    const [note] = await sql<{ id: string }[]>`
      INSERT INTO public.notes (highlight_id, user_id, text)
      VALUES (${highlightId}, ${user.id}, ${"visible-pre-delete"})
      RETURNING id
    `;
    noteId = note.id;
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
    await shutdown();
  });

  async function feedAsUser(uid: string) {
    return sql.begin(async (txn) => {
      await txn`SELECT set_config('request.jwt.claims', ${JSON.stringify({
        sub: uid,
        role: "authenticated",
      })}, true)`;
      await txn`SET LOCAL ROLE authenticated`;
      return txn<
        { highlight_id: string; note_text: string | null }[]
      >`SELECT highlight_id, note_text FROM get_highlight_feed('recent', NULL, 50, NULL)`;
    });
  }

  it("returns note_text before soft-delete", async () => {
    const rows = await feedAsUser(user.id);
    const ours = rows.find((r) => r.highlight_id === highlightId);
    expect(ours, "highlight should appear in feed").toBeDefined();
    expect(ours!.note_text).toBe("visible-pre-delete");
  });

  it("hides note_text after UPDATE deleted_at", async () => {
    await sql`UPDATE public.notes SET deleted_at = now() WHERE id = ${noteId}`;

    const rows = await feedAsUser(user.id);
    const ours = rows.find((r) => r.highlight_id === highlightId);
    expect(
      ours,
      "highlight should still appear after note soft-delete",
    ).toBeDefined();
    expect(ours!.note_text).toBeNull();
  });

  it("tombstoned row remains queryable via system view (sync hot path)", async () => {
    // The sync path uses `WHERE updated_at > :lastSyncedAt`, picking up
    // soft-deletes via the `updated_at` trigger. Smoke-test that the row is
    // still present with deleted_at non-null.
    const [row] = await sql<
      { id: string; deleted_at: string | null }[]
    >`SELECT id, deleted_at FROM public.notes WHERE id = ${noteId}`;
    expect(row).toBeDefined();
    expect(row.deleted_at).not.toBeNull();
  });
});
