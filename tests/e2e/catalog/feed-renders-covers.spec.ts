import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";
import {
  FIXTURES,
  seedCatalogRow,
  type FixtureKey,
} from "../helpers/seed-catalog";

// Render gate for the Catalog Architecture Refit (librito-io/web#431).
// Proves a catalog-populated book renders its cover THUMBNAIL on the feed
// (/app), across both ISBN- and title/author-keyed join paths. Hermetic:
// rows + cover bytes are seeded directly via the admin client (no live
// OL/GB/iTunes, no resolver). The catalog *description* is not shown on the
// feed — only on book detail — so that half is covered by
// book-detail-renders-metadata.spec.ts.

const FEED_FIXTURES: FixtureKey[] = ["isbn-full", "ta-full"];

test("feed renders cover thumbnail for ISBN- and TA-keyed books", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("feed-covers");
  const seededBookIds: string[] = [];
  try {
    let hashCounter = 0;
    for (const key of FEED_FIXTURES) {
      const fix = FIXTURES[key];
      // book_catalog row + committed cover image uploaded to local Storage.
      await seedCatalogRow(key);

      // book_hash is constrained to ^[0-9a-f]{8}$. Sequential hex keeps the
      // per-user UNIQUE(book_hash) constraint satisfied across fixtures.
      hashCounter += 1;
      const bookHash = hashCounter.toString(16).padStart(8, "0");
      const { data: book, error: bErr } = await admin
        .from("books")
        .insert({
          user_id: user.id,
          book_hash: bookHash,
          title: fix.title,
          author: fix.author,
          isbn: fix.isbn ?? null,
        })
        .select("id")
        .single();
      if (bErr || !book) throw new Error(`seed books: ${bErr?.message}`);
      seededBookIds.push(book.id);

      // Feed renders books that have highlights — seed one per book.
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
    await page.goto("/app");
    await awaitHydration(page);

    // Both books' titles render.
    for (const key of FEED_FIXTURES) {
      await expect(
        page.getByText(FIXTURES[key].title, { exact: true }),
      ).toBeVisible();
    }

    // HighlightCard renders <img class="book-cover"> only when the cover URL
    // resolved (a cold-miss / null cover renders a <div> placeholder with the
    // same class). Both fixtures carry covers, so exactly two <img> cards must
    // appear — and each must actually decode (naturalWidth > 0), which only
    // holds if the seeded storage URL serves 200. A join miss or unserved
    // cover collapses one card to the placeholder div and fails the count.
    const covers = page.locator("img.book-cover");
    await expect(covers).toHaveCount(FEED_FIXTURES.length);
    const count = await covers.count();
    for (let i = 0; i < count; i += 1) {
      await expect(covers.nth(i)).toBeVisible();
      const decoded = await covers
        .nth(i)
        .evaluate(
          (el) =>
            el instanceof HTMLImageElement &&
            el.complete &&
            el.naturalWidth > 0,
        );
      expect(decoded, `cover image ${i} decoded`).toBe(true);
    }
  } finally {
    for (const id of seededBookIds) {
      await admin.from("books").delete().eq("id", id);
    }
    await cleanupUser(user.id);
  }
});
