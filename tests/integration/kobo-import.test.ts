import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  getAdmin,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";
import {
  processKoboImport,
  synthesizeBookHash,
  type KoboImportItem,
} from "../../src/lib/server/import/kobo";

// Behaviour guard for the Kobo import path (librito-io/web#497) against real
// Postgres. Exercises processKoboImport with the service-role admin client
// (the same client the route uses) and asserts the #497 acceptance criteria
// that need a live DB: ISBN reuse, sideload synthesis + re-import stability,
// source_uid idempotency, no soft-delete resurrection, and feed render.

const SKIP = !process.env.INTEGRATION;

function item(overrides: Partial<KoboImportItem> = {}): KoboImportItem {
  return {
    source_uid: "bm-1",
    text: "imported highlight",
    title: "Sideloaded Book",
    author: "Some Author",
    content_id: "file:///mnt/onboard/sideload.epub",
    isbn: null,
    chapter_title: null,
    created_at: null,
    ...overrides,
  };
}

describe.skipIf(SKIP)("kobo import (#497)", () => {
  const sql = getSql();
  const admin = getAdmin();
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser("kobo-import");
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
    await shutdown();
  });

  it("attaches an ISBN-matched import to an existing book row", async () => {
    // Seed a book the user already has (e.g. from a PaperS3 sync) with an ISBN.
    const [book] = await sql<{ id: string }[]>`
      INSERT INTO public.books (user_id, book_hash, title, author, isbn)
      VALUES (${user.id}, ${"aaaa0001"}, ${"Existing"}, ${"Author"}, ${"9781111111111"})
      RETURNING id
    `;

    const result = await processKoboImport(admin, user.id, [
      item({
        source_uid: "isbn-bm-1",
        isbn: "9781111111111",
        content_id: "",
        title: "Existing",
        author: "Author",
      }),
    ]);
    expect(result.books).toBe(1);
    expect(result.imported).toBe(1);

    const [hl] = await sql<{ book_id: string; source: string }[]>`
      SELECT book_id, source FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"isbn-bm-1"}
    `;
    expect(hl.book_id).toBe(book.id); // reused, not a new book
    expect(hl.source).toBe("kobo");

    // No duplicate book created for that ISBN.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.books
      WHERE user_id = ${user.id} AND isbn = ${"9781111111111"}
    `;
    expect(n).toBe(1);
  });

  it("synthesizes a book for a sideload and re-import maps to the same book", async () => {
    const it1 = item({ source_uid: "side-bm-1" });
    await processKoboImport(admin, user.id, [it1]);

    const [{ n: booksAfterFirst }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.books
      WHERE user_id = ${user.id} AND title = ${"Sideloaded Book"}
    `;
    expect(booksAfterFirst).toBe(1);

    // Re-import the same batch — must map to the SAME synthesized book.
    await processKoboImport(admin, user.id, [it1]);
    const [{ n: booksAfterSecond }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.books
      WHERE user_id = ${user.id} AND title = ${"Sideloaded Book"}
    `;
    expect(booksAfterSecond).toBe(1); // no duplicate book
  });

  it("re-POSTing the same source_uid UPDATEs, no duplicate highlight", async () => {
    await processKoboImport(admin, user.id, [
      item({ source_uid: "dup-bm", text: "first" }),
    ]);
    await processKoboImport(admin, user.id, [
      item({ source_uid: "dup-bm", text: "second" }),
    ]);

    const rows = await sql<{ text: string }[]>`
      SELECT text FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"dup-bm"}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("second"); // updated in place
  });

  it("persists the agent's created_at and does not rewrite it on re-import", async () => {
    const origin = "2020-05-06T07:08:09.000Z";
    await processKoboImport(admin, user.id, [
      item({ source_uid: "ca-bm", text: "v1", created_at: origin }),
    ]);
    const [first] = await sql<{ created_at: string }[]>`
      SELECT created_at FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"ca-bm"}
    `;
    expect(new Date(first.created_at).toISOString()).toBe(origin);

    // Re-import with a different created_at — origin time must NOT change.
    await processKoboImport(admin, user.id, [
      item({
        source_uid: "ca-bm",
        text: "v2",
        created_at: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const [second] = await sql<{ created_at: string; text: string }[]>`
      SELECT created_at, text FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"ca-bm"}
    `;
    expect(new Date(second.created_at).toISOString()).toBe(origin); // unchanged
    expect(second.text).toBe("v2"); // text still updated
  });

  it("does not resurrect a web soft-deleted highlight on re-import", async () => {
    const dItem = item({ source_uid: "del-bm", text: "trash me" });
    await processKoboImport(admin, user.id, [dItem]);

    // User trashes it on the web (soft-delete).
    await sql`
      UPDATE public.highlights SET deleted_at = now()
      WHERE user_id = ${user.id} AND source_uid = ${"del-bm"}
    `;

    // Agent re-POSTs the same highlight.
    await processKoboImport(admin, user.id, [dItem]);

    const [row] = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"del-bm"}
    `;
    expect(row.deleted_at).not.toBeNull(); // still trashed
  });

  it("imported row renders in the feed as plain text (NULL word fields)", async () => {
    await processKoboImport(admin, user.id, [
      item({
        source_uid: "feed-bm",
        text: "feed me",
        title: "Feedable",
        author: "A",
      }),
    ]);

    const [hl] = await sql<
      {
        start_word: number | null;
        end_word: number | null;
        chapter_index: number | null;
        styles: string | null;
      }[]
    >`
      SELECT start_word, end_word, chapter_index, styles
      FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ${"feed-bm"}
    `;
    expect(hl.start_word).toBeNull();
    expect(hl.end_word).toBeNull();
    expect(hl.chapter_index).toBeNull();
    expect(hl.styles).toBeNull();

    // The feed RPC must return the row without error despite NULL word fields.
    const rows = await sql.begin(async (txn) => {
      await txn`SELECT set_config('request.jwt.claims', ${JSON.stringify({
        sub: user.id,
        role: "authenticated",
      })}, true)`;
      await txn`SET LOCAL ROLE authenticated`;
      return txn<{ text: string }[]>`
        SELECT text FROM get_highlight_feed('recent', NULL, 50, NULL)
      `;
    });
    expect(rows.some((r) => r.text === "feed me")).toBe(true);
  });

  it("orders 'recent' by authoring time (created_at), not collapsed updated_at, after a full re-import", async () => {
    // Regression for the feed bug exposed by the Kobo full-resend: the agent
    // re-POSTs the entire highlight set every sync, so ON CONFLICT DO UPDATE
    // fires update_updated_at on every row and collapses updated_at to one
    // value. The 'recent' sort keyed on updated_at then ties on every row and
    // falls back to the random-UUID tiebreak — arbitrary order. 'recent' must
    // instead order by created_at (stable authoring time, INSERT-only).
    const contentId = "file:///mnt/onboard/recent-ordering.epub";
    const bookHash = synthesizeBookHash({ contentId });
    const uids = ["ord-a", "ord-b", "ord-c", "ord-d"];

    // Full set, one synthesized book. created_at defaults here; we overwrite it
    // below so authoring time is ANTI-correlated with the random highlight UUID.
    // That makes the buggy (updated_at-tie → id DESC) order the exact reverse of
    // the correct (created_at DESC) order: a deterministic failure under the
    // bug, not a 1/N! coincidence.
    const set = uids.map((uid) =>
      item({
        source_uid: uid,
        text: uid,
        title: "Recent Ordering",
        author: "A",
        content_id: contentId,
        isbn: null,
        created_at: null,
      }),
    );
    await processKoboImport(admin, user.id, set);

    // Read the assigned UUIDs ascending, then stamp created_at so the smallest
    // id is the NEWEST highlight. → id ASC == created_at DESC == expected order.
    const seeded = await sql<{ id: string; source_uid: string }[]>`
      SELECT id, source_uid FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ANY(${uids})
      ORDER BY id ASC
    `;
    const dates = [
      "2026-06-10T00:00:00.000Z",
      "2026-06-09T00:00:00.000Z",
      "2026-06-08T00:00:00.000Z",
      "2026-06-07T00:00:00.000Z",
    ];
    for (let i = 0; i < seeded.length; i++) {
      await sql`
        UPDATE public.highlights SET created_at = ${dates[i]}
        WHERE id = ${seeded[i].id}
      `;
    }
    const expectedOrder = seeded.map((r) => r.source_uid); // newest → oldest

    // Full re-send: collapses updated_at across the set; created_at preserved.
    await processKoboImport(admin, user.id, set);

    const [collapse] = await sql<{ du: number; dc: number }[]>`
      SELECT count(DISTINCT updated_at)::int AS du,
             count(DISTINCT created_at)::int AS dc
      FROM public.highlights
      WHERE user_id = ${user.id} AND source_uid = ANY(${uids})
    `;
    expect(collapse.du).toBe(1); // updated_at collapsed (the bug condition)
    expect(collapse.dc).toBe(4); // created_at intact (the recovery signal)

    const feed = await sql.begin(async (txn) => {
      await txn`SELECT set_config('request.jwt.claims', ${JSON.stringify({
        sub: user.id,
        role: "authenticated",
      })}, true)`;
      await txn`SET LOCAL ROLE authenticated`;
      return txn<{ text: string }[]>`
        SELECT text FROM get_highlight_feed('recent', NULL, 50, ${bookHash})
      `;
    });
    expect(feed.map((r) => r.text)).toEqual(expectedOrder);
  });
});
