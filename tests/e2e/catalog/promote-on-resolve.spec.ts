import { test, expect } from "@playwright/test";
import {
  createE2EUser,
  cleanupUser,
  login,
  type E2EUser,
} from "../helpers/auth";
import { getAdmin } from "../helpers/supabase";
import { awaitHydration } from "../helpers/hydrate";

// Promote-on-resolve closes the duplicate-row gap (issue #427) at the data
// layer. End-to-end shape:
//   1. Book first synced ISBN-less → TA-keyed book_catalog row.
//   2. Firmware fix backfills books.isbn.
//   3. Next feed render schedules resolveIsbn with title+author ctx.
//   4. resolveIsbn calls promote_ta_to_isbn(isbn, ta_key) — TA row's
//      isbn column gets stamped, no duplicate row created.
//
// The TA row is seeded fully populated so the post-promote recurse hits
// the resolver's cache short-circuit and does NOT walk upstream chains
// (which would require API keys and network in a local e2e run).

const RUTH_ISBN = "9780374614911";
const RUTH_TITLE = "Ruth";
const RUTH_AUTHOR = "Kate Riley";
const RUTH_TA_KEY = "ruth|kate riley";
const BOOK_HASH = "a1b2c3d4";

let user: E2EUser;

test.beforeEach(async () => {
  user = await createE2EUser("promote");
  const admin = getAdmin();
  // Clean any leftover catalog row from a previous failed run (catalog
  // is shared per-ISBN, not user-scoped — cleanupUser cascades books +
  // highlights but NOT book_catalog).
  await admin
    .from("book_catalog")
    .delete()
    .or(`isbn.eq.${RUTH_ISBN},normalized_title_author.eq.${RUTH_TA_KEY}`);
});

test.afterEach(async () => {
  const admin = getAdmin();
  await admin
    .from("book_catalog")
    .delete()
    .or(`isbn.eq.${RUTH_ISBN},normalized_title_author.eq.${RUTH_TA_KEY}`);
  if (user) await cleanupUser(user.id);
});

test("promote-on-resolve consolidates a TA-keyed catalog row into ISBN-keyed", async ({
  page,
}) => {
  const admin = getAdmin();

  // 1. Seed a books row with isbn=null + a TA-keyed book_catalog row
  //    fully populated so the post-promote recurse can short-circuit.
  const { data: bookRow, error: bookErr } = await admin
    .from("books")
    .insert({
      user_id: user.id,
      book_hash: BOOK_HASH,
      title: RUTH_TITLE,
      author: RUTH_AUTHOR,
      isbn: null,
    })
    .select("id")
    .single();
  expect(bookErr).toBeNull();

  // One highlight so the book surfaces in the feed (the feed shows
  // highlights, not books).
  const { error: hlErr } = await admin.from("highlights").insert({
    book_id: bookRow!.id,
    user_id: user.id,
    chapter_index: 0,
    start_word: 0,
    end_word: 10,
    text: "Sample highlight text for the promote-on-resolve e2e fixture.",
  });
  expect(hlErr).toBeNull();

  // TA-keyed catalog row — every tracked field populated so the
  // post-promote recurse short-circuits via the cache guard.
  const { error: catErr } = await admin.from("book_catalog").insert({
    isbn: null,
    normalized_title_author: RUTH_TA_KEY,
    title: RUTH_TITLE,
    author: RUTH_AUTHOR,
    storage_path: "ab/promote-test-cover.jpg",
    cover_storage_backend: "supabase",
    cover_source: "openlibrary_isbn_direct",
    cover_max_width: 1200,
    image_sha256: "a".repeat(64),
    pending_storage: false,
    cover_attempted_at: new Date().toISOString(),
    description:
      "Fictional Ruth — pre-seeded for the promote-on-resolve fixture.",
    description_provider: "openlibrary",
    description_attempted_at: new Date().toISOString(),
    publisher: "Test Press",
    publisher_provider: "openlibrary",
    publisher_attempted_at: new Date().toISOString(),
    published_date: "2024-01-01",
    published_date_provider: "openlibrary",
    published_date_attempted_at: new Date().toISOString(),
    subjects: ["fiction"],
    subjects_provider: "openlibrary",
    subjects_attempted_at: new Date().toISOString(),
    page_count: 200,
    page_count_provider: "openlibrary",
    page_count_attempted_at: new Date().toISOString(),
  });
  expect(catErr).toBeNull();

  // Sanity check: exactly one TA-keyed catalog row, isbn null.
  const { data: rowsBefore } = await admin
    .from("book_catalog")
    .select("isbn, normalized_title_author")
    .or(`isbn.eq.${RUTH_ISBN},normalized_title_author.eq.${RUTH_TA_KEY}`);
  expect(rowsBefore).toHaveLength(1);
  expect(rowsBefore![0].isbn).toBeNull();
  expect(rowsBefore![0].normalized_title_author).toBe(RUTH_TA_KEY);

  // 2. Simulate firmware backfilling the ISBN on the books row.
  const { error: updErr } = await admin
    .from("books")
    .update({ isbn: RUTH_ISBN })
    .eq("id", bookRow!.id);
  expect(updErr).toBeNull();

  // 3. Render the feed — triggers feed-enrichment, which schedules
  //    resolveIsbn(ctx={title,author}). The resolver calls
  //    promote_ta_to_isbn(isbn, ta_key) before mutex acquire. The
  //    main feed page is `/app/` (`+page.svelte`); `/app/feed` is the
  //    pagination JSON endpoint.
  await login(page, user);
  await page.goto("/app/");
  await awaitHydration(page);

  // 4. Poll the DB for the promoted row. The background resolve runs
  //    via runInBackground; we don't observe it from the UI, just from
  //    catalog state.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("book_catalog")
          .select("isbn")
          .eq("normalized_title_author", RUTH_TA_KEY)
          .maybeSingle();
        return data?.isbn ?? null;
      },
      { timeout: 15_000, intervals: [200, 500, 1000] },
    )
    .toBe(RUTH_ISBN);

  // 5. Single row total — no duplicate created.
  const { data: rowsAfter } = await admin
    .from("book_catalog")
    .select("id, isbn, normalized_title_author")
    .or(`isbn.eq.${RUTH_ISBN},normalized_title_author.eq.${RUTH_TA_KEY}`);
  expect(rowsAfter).toHaveLength(1);
  expect(rowsAfter![0].isbn).toBe(RUTH_ISBN);
  expect(rowsAfter![0].normalized_title_author).toBe(RUTH_TA_KEY);
});
