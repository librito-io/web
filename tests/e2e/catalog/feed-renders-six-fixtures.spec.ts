import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";
import {
  FIXTURES,
  seedFixture,
  type FixtureKey,
} from "../helpers/seed-catalog";

// Acceptance gate for the catalog refit. Network-bound: seedFixture()
// drives live OL/GB/iTunes upstreams (today) or cassette playback (after
// librito-io/web#431). Default CI omits CATALOG_E2E_NETWORK and skips
// this spec; setting the env var on an operator workstation runs it.
test.skip(
  !process.env.CATALOG_E2E_NETWORK,
  "Requires cassette tooling or live network — tracked in librito-io/web#431",
);

test("six fixtures render cover + description on feed", async ({ page }) => {
  const admin = getAdmin();
  const user = await createE2EUser("feed-six-fixtures");
  const seededBookIds: string[] = [];
  // Scope cold-start delete to THIS suite's fixture keys — unconditional
  // `delete().not("id","is",null)` would erase any unrelated catalog
  // state on the local Supabase, which is shared across specs and dev
  // sessions. ISBN-keyed fixtures by ISBN; TA-keyed fixtures by the
  // resolver's normalized_title_author key (inlined so the helper file
  // doesn't have to pull $lib/server/catalog/* into the e2e harness).
  const stripTA = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]+/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const fixtureIsbns: string[] = [];
  const fixtureTAKeys: string[] = [];
  for (const fix of Object.values(FIXTURES)) {
    if ("isbn" in fix && fix.isbn) {
      fixtureIsbns.push(fix.isbn);
    } else {
      fixtureTAKeys.push(`${stripTA(fix.title)}|${stripTA(fix.author)}`);
    }
  }
  try {
    if (fixtureIsbns.length > 0) {
      await admin.from("book_catalog").delete().in("isbn", fixtureIsbns);
    }
    if (fixtureTAKeys.length > 0) {
      await admin
        .from("book_catalog")
        .delete()
        .in("normalized_title_author", fixtureTAKeys);
    }

    // Per fixture: seed `books` row + resolve catalog via seedFixture +
    // seed one `highlights` row (feed renders books that have highlights).
    const entries = Object.entries(FIXTURES) as Array<
      [FixtureKey, (typeof FIXTURES)[FixtureKey]]
    >;
    let hashCounter = 0;
    for (const [key, fix] of entries) {
      // book_hash is constrained to ^[0-9a-f]{8}$ (FNV-1a hex). Derive a
      // unique 8-hex value per fixture so the per-user UNIQUE(book_hash)
      // constraint doesn't collide across the six rows.
      hashCounter += 1;
      const bookHash = (Date.now() & 0xffffff)
        .toString(16)
        .padStart(6, "0")
        .slice(-6)
        .concat(hashCounter.toString(16).padStart(2, "0"));
      const { data: book, error: bErr } = await admin
        .from("books")
        .insert({
          user_id: user.id,
          book_hash: bookHash,
          title: fix.title,
          author: fix.author,
          isbn: "isbn" in fix ? fix.isbn : null,
        })
        .select("id")
        .single();
      if (bErr || !book) throw new Error(`seed books: ${bErr?.message}`);
      seededBookIds.push(book.id);

      await seedFixture(key);

      const { error: hErr } = await admin.from("highlights").insert({
        user_id: user.id,
        book_id: book.id,
        chapter_index: 0,
        start_word: 0,
        end_word: 10,
        text: `Sample highlight for ${fix.title}`,
      });
      if (hErr) throw new Error(`seed highlights: ${hErr.message}`);
    }

    await login(page, user);
    await page.goto("/app/feed");
    await awaitHydration(page);

    for (const fix of Object.values(FIXTURES)) {
      await expect(page.getByText(fix.title, { exact: true })).toBeVisible();
      await expect(page.getByText(fix.author, { exact: true })).toBeVisible();
    }

    // Scoped per-fixture assert — querying the whole book_catalog
    // table would catch unrelated rows on a shared local Supabase.
    for (const fix of Object.values(FIXTURES)) {
      const q = admin.from("book_catalog").select("storage_path, description");
      const { data } =
        "isbn" in fix && fix.isbn
          ? await q.eq("isbn", fix.isbn).maybeSingle()
          : await q
              .eq(
                "normalized_title_author",
                `${stripTA(fix.title)}|${stripTA(fix.author)}`,
              )
              .maybeSingle();
      const label =
        "isbn" in fix && fix.isbn ? fix.isbn : `${fix.title}|${fix.author}`;
      expect(data, `catalog row for ${label}`).not.toBeNull();
      expect(data?.storage_path, `cover for ${label}`).not.toBeNull();
      expect(data?.description, `description for ${label}`).not.toBeNull();
    }
  } finally {
    for (const id of seededBookIds) {
      await admin.from("books").delete().eq("id", id);
    }
    await cleanupUser(user.id);
  }
});
