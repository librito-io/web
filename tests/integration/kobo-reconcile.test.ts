import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  getAdmin,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// RPC behaviour guard for reconcile_kobo_highlights (web#527) against real
// Postgres. Calls the RPC directly with the service-role client and asserts
// the acceptance criteria that need a live DB: amend invariants, precondition
// fallback, stamp set/clear transitions, user scoping, chapter COALESCE,
// cross-book uid detection (STEP 0), and grants.

const SKIP = !process.env.INTEGRATION;

/** Seed one kobo highlight directly; returns its row id. */
async function seedKobo(
  sql: ReturnType<typeof getSql>,
  userId: string,
  bookId: string,
  o: {
    uid: string;
    text: string;
    chapter?: string | null;
    deletedAt?: string | null;
  },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO public.highlights
      (book_id, user_id, source, source_uid, text, chapter_title, deleted_at)
    VALUES (${bookId}, ${userId}, 'kobo', ${o.uid}, ${o.text},
            ${o.chapter ?? null}, ${o.deletedAt ?? null})
    RETURNING id
  `;
  return row.id;
}

async function seedBook(
  sql: ReturnType<typeof getSql>,
  userId: string,
  hash: string,
): Promise<string> {
  const [book] = await sql<{ id: string }[]>`
    INSERT INTO public.books (user_id, book_hash, title, author)
    VALUES (${userId}, ${hash}, ${"Reconcile Book"}, ${"Author"})
    RETURNING id
  `;
  return book.id;
}

describe.skipIf(SKIP)("reconcile_kobo_highlights RPC (#527)", () => {
  const sql = getSql();
  const admin = getAdmin();
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser("kobo-reconcile");
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
    await shutdown();
  });

  it("amend keeps id, created_at, deleted_at, and an attached note", async () => {
    const bookId = await seedBook(sql, user.id, "beef0001");
    const id = await seedKobo(sql, user.id, bookId, {
      uid: "old-uid",
      text: "the quick brown fox jumps over",
    });
    // Pin a distinctive created_at and a trashed state.
    await sql`UPDATE public.highlights
              SET created_at = ${"2020-01-02T03:04:05.000Z"},
                  deleted_at = ${"2020-02-02T00:00:00.000Z"}
              WHERE id = ${id}`;
    // Attach a web-authored note (FK rides the row id).
    await sql`INSERT INTO public.notes (highlight_id, user_id, text)
              VALUES (${id}, ${user.id}, ${"my note"})`;

    const { data, error } = await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [
        {
          book_id: bookId,
          source_uid: "new-uid",
          text: "well the quick brown fox jumps over the lazy dog",
          chapter_title: null,
          created_at: null,
        },
      ],
      p_amends: [
        {
          id,
          source_uid: "new-uid",
          text: "well the quick brown fox jumps over the lazy dog",
          chapter_title: null,
        },
      ],
    });
    expect(error).toBeNull();
    expect((data as { amended: number }).amended).toBe(1);

    const [row] = await sql<
      {
        id: string;
        source_uid: string;
        text: string;
        created_at: string;
        deleted_at: string | null;
      }[]
    >`SELECT id, source_uid, text, created_at, deleted_at
        FROM public.highlights WHERE id = ${id}`;
    expect(row.source_uid).toBe("new-uid");
    expect(row.text).toBe("well the quick brown fox jumps over the lazy dog");
    expect(new Date(row.created_at).toISOString()).toBe(
      "2020-01-02T03:04:05.000Z",
    );
    expect(row.deleted_at).not.toBeNull(); // trashed stays trashed

    // Note survives on the same row, no duplicate highlight inserted.
    const [{ n: noteN }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notes WHERE highlight_id = ${id}`;
    expect(noteN).toBe(1);
    // Count ALL rows incl. soft-deleted (this row is trashed) — proves the amend
    // updated in place rather than inserting a second physical row.
    const [{ n: hlN }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.highlights WHERE book_id = ${bookId}`;
    expect(hlN).toBe(1);
  });

  it("precondition violation (old uid present in incoming) falls back to insert", async () => {
    const bookId = await seedBook(sql, user.id, "beef0002");
    const id = await seedKobo(sql, user.id, bookId, {
      uid: "u-keep",
      text: "original passage text long enough",
    });

    const { data } = await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      // The full set still contains u-keep → it is NOT absent → amend skipped.
      p_rows: [
        {
          book_id: bookId,
          source_uid: "u-keep",
          text: "original passage text long enough",
          chapter_title: null,
          created_at: null,
        },
        {
          book_id: bookId,
          source_uid: "u-new",
          text: "original passage text long enough extended",
          chapter_title: null,
          created_at: null,
        },
      ],
      p_amends: [
        {
          id,
          source_uid: "u-new",
          text: "original passage text long enough extended",
          chapter_title: null,
        },
      ],
    });
    expect((data as { amended: number }).amended).toBe(0); // amend skipped

    const rows = await sql<{ source_uid: string }[]>`
      SELECT source_uid FROM public.highlights
      WHERE book_id = ${bookId} ORDER BY source_uid`;
    expect(rows.map((r) => r.source_uid)).toEqual(["u-keep", "u-new"]); // duplicate, safe direction
  });

  it("stamp SET on first absence, no-write when already stamped, CLEAR on reappearance", async () => {
    const bookId = await seedBook(sql, user.id, "beef0003");
    await seedKobo(sql, user.id, bookId, {
      uid: "absent-one",
      text: "absent passage long enough text",
    });
    // Cover the book with a DIFFERENT uid so absent-one is absent.
    const cover = {
      book_id: bookId,
      source_uid: "cover-uid",
      text: "cover passage long enough text",
      chapter_title: null,
      created_at: null,
    };

    const r1 = await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [cover],
      p_amends: [],
    });
    expect((r1.data as { stamped: number }).stamped).toBe(1);
    const [s1] = await sql<{ removed_from_device_at: Date | null }[]>`
      SELECT removed_from_device_at FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"absent-one"}`;
    expect(s1.removed_from_device_at).not.toBeNull();

    // Second identical import — already stamped → transition guard → no write.
    const r2 = await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [cover],
      p_amends: [],
    });
    expect((r2.data as { stamped: number }).stamped).toBe(0);
    const [s2] = await sql<{ removed_from_device_at: Date | null }[]>`
      SELECT removed_from_device_at FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"absent-one"}`;
    expect(s2.removed_from_device_at?.toISOString()).toBe(
      s1.removed_from_device_at?.toISOString(),
    ); // unchanged

    // absent-one reappears in the incoming set → CLEAR.
    const r3 = await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [
        cover,
        {
          book_id: bookId,
          source_uid: "absent-one",
          text: "absent passage long enough text",
          chapter_title: null,
          created_at: null,
        },
      ],
      p_amends: [],
    });
    expect((r3.data as { cleared: number }).cleared).toBe(1);
    const [s3] = await sql<{ removed_from_device_at: Date | null }[]>`
      SELECT removed_from_device_at FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"absent-one"}`;
    expect(s3.removed_from_device_at).toBeNull();
  });

  it("never stamps a trashed row", async () => {
    const bookId = await seedBook(sql, user.id, "beef0004");
    await seedKobo(sql, user.id, bookId, {
      uid: "trashed-absent",
      text: "trashed absent passage long text",
      deletedAt: "2020-01-01T00:00:00.000Z",
    });
    await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [
        {
          book_id: bookId,
          source_uid: "cover-uid-2",
          text: "cover passage long enough text",
          chapter_title: null,
          created_at: null,
        },
      ],
      p_amends: [],
    });
    const [row] = await sql<{ removed_from_device_at: string | null }[]>`
      SELECT removed_from_device_at FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"trashed-absent"}`;
    expect(row.removed_from_device_at).toBeNull(); // trashed → never stamped
  });

  it("amend is scoped to p_user_id — a second user's row id is untouched", async () => {
    const other = await createTestUser("kobo-reconcile-other");
    try {
      // Seed a highlight under `other`'s book — this is the victim row.
      const otherBookId = await seedBook(sql, other.id, "beef0005");
      const foreignId = await seedKobo(sql, other.id, otherBookId, {
        uid: "victim-uid",
        text: "victim passage long enough text",
      });
      // Give `user` their own book so the p_rows upsert step has a valid FK.
      // The attack vector is p_amends[].id = foreignId (cross-user row reference).
      // The WHERE h.user_id = p_user_id in the amend step must block the write.
      const userBookId = await seedBook(sql, user.id, "beef0005");
      const { data, error } = await admin.rpc("reconcile_kobo_highlights", {
        p_user_id: user.id,
        p_rows: [
          {
            book_id: userBookId,
            source_uid: "attacker-uid",
            text: "victim passage long enough text overwritten",
            chapter_title: null,
            created_at: null,
          },
        ],
        p_amends: [
          {
            id: foreignId,
            source_uid: "attacker-uid",
            text: "victim passage long enough text overwritten",
            chapter_title: null,
          },
        ],
      });
      expect(error).toBeNull();
      expect((data as { amended: number }).amended).toBe(0); // user qual blocked it
      const [row] = await sql<{ source_uid: string; text: string }[]>`
        SELECT source_uid, text FROM public.highlights WHERE id = ${foreignId}`;
      expect(row.source_uid).toBe("victim-uid"); // untouched
    } finally {
      await deleteTestUser(other.id);
    }
  });

  it("chapter_title COALESCE: incoming NULL preserves stored title, no double write (amend + upsert)", async () => {
    const bookId = await seedBook(sql, user.id, "beef0006");
    const id = await seedKobo(sql, user.id, bookId, {
      uid: "ch-old",
      text: "chapter passage long enough text",
      chapter: "Chapter One",
    });

    // Amend to a new uid with NULL chapter_title — stored "Chapter One" must persist.
    await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [
        {
          book_id: bookId,
          source_uid: "ch-new",
          text: "chapter passage long enough text",
          chapter_title: null,
          created_at: null,
        },
      ],
      p_amends: [
        {
          id,
          source_uid: "ch-new",
          text: "chapter passage long enough text",
          chapter_title: null,
        },
      ],
    });
    const [afterAmend] = await sql<
      { chapter_title: string | null; updated_at: string }[]
    >`
      SELECT chapter_title, updated_at FROM public.highlights WHERE id = ${id}`;
    expect(afterAmend.chapter_title).toBe("Chapter One"); // preserved, not clobbered to NULL

    // Re-send the SAME full set (ch-new now in DB → no amend, pure upsert). The
    // shared COALESCE makes STEP 2's gate see no change, so the amended row is a
    // STABLE no-op — updated_at must NOT advance. Under a broken gate comparing
    // raw EXCLUDED.chapter_title (null) to stored "Chapter One", this re-send
    // would rewrite the row every time and this assertion would fail.
    await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [
        {
          book_id: bookId,
          source_uid: "ch-new",
          text: "chapter passage long enough text",
          chapter_title: null,
          created_at: null,
        },
      ],
      p_amends: [],
    });
    const [afterResend] = await sql<
      { chapter_title: string | null; updated_at: string }[]
    >`
      SELECT chapter_title, updated_at FROM public.highlights WHERE id = ${id}`;
    expect(afterResend.chapter_title).toBe("Chapter One"); // still preserved
    expect(new Date(afterResend.updated_at).getTime()).toBe(
      new Date(afterAmend.updated_at).getTime(),
    ); // no second write — shared-COALESCE no-op
  });

  it("no-op full re-import does not bump updated_at (conditional gate preserved)", async () => {
    const bookId = await seedBook(sql, user.id, "beef0007");
    const id = await seedKobo(sql, user.id, bookId, {
      uid: "stable-uid",
      text: "stable passage long enough text",
      chapter: "Ch",
    });
    const [before] = await sql<{ updated_at: string }[]>`
      SELECT updated_at FROM public.highlights WHERE id = ${id}`;
    await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [
        {
          book_id: bookId,
          source_uid: "stable-uid",
          text: "stable passage long enough text",
          chapter_title: "Ch",
          created_at: null,
        },
      ],
      p_amends: [],
    });
    const [after] = await sql<{ updated_at: string }[]>`
      SELECT updated_at FROM public.highlights WHERE id = ${id}`;
    expect(new Date(after.updated_at).getTime()).toBe(
      new Date(before.updated_at).getTime(),
    );
  });

  it("cross_book_uid_hits counts a uid that exists under a different book_id", async () => {
    // Same uid stranded under an OLD book (book-re-resolution edge, §7). The
    // incoming item resolves to a NEW book; the RPC's STEP 0 must report 1.
    const oldBook = await seedBook(sql, user.id, "beef0008");
    const newBook = await seedBook(sql, user.id, "beef0009");
    await seedKobo(sql, user.id, oldBook, {
      uid: "stranded-uid",
      text: "stranded passage long enough text",
    });
    const { data } = await admin.rpc("reconcile_kobo_highlights", {
      p_user_id: user.id,
      p_rows: [
        {
          book_id: newBook,
          source_uid: "stranded-uid",
          text: "stranded passage long enough text",
          chapter_title: null,
          created_at: null,
        },
      ],
      p_amends: [],
    });
    expect((data as { cross_book_uid_hits: number }).cross_book_uid_hits).toBe(
      1,
    );
  });

  it("grants: anon + authenticated have no EXECUTE, service_role does", async () => {
    const [g] = await sql<
      { anon: boolean; auth: boolean; svc: boolean }[]
    >`SELECT
        has_function_privilege('anon', 'public.reconcile_kobo_highlights(uuid, jsonb, jsonb)', 'EXECUTE') AS anon,
        has_function_privilege('authenticated', 'public.reconcile_kobo_highlights(uuid, jsonb, jsonb)', 'EXECUTE') AS auth,
        has_function_privilege('service_role', 'public.reconcile_kobo_highlights(uuid, jsonb, jsonb)', 'EXECUTE') AS svc`;
    expect(g.anon).toBe(false);
    expect(g.auth).toBe(false);
    expect(g.svc).toBe(true);
  });
});
