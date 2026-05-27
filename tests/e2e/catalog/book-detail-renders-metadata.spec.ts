import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";
import { FIXTURES, seedFixture } from "../helpers/seed-catalog";

test.skip(
  !process.env.CATALOG_E2E_NETWORK,
  "Requires cassette tooling or live network — tracked in librito-io/web#431",
);

test("book detail renders cover + metadata for resolved fixture", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("book-detail-metadata");
  const key = "the-compound" as const;
  const fix = FIXTURES[key];
  const bookHash = `${key}-hash-${Date.now()}`;
  let bookId: string | null = null;
  try {
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
    bookId = book.id;

    await seedFixture(key);

    await login(page, user);
    await page.goto(`/app/book/${bookHash}`);
    await awaitHydration(page);

    await expect(page.getByText(fix.title, { exact: true })).toBeVisible();
    await expect(page.locator("img[alt*='Cover' i]").first()).toBeVisible();
    // published_date renders as four-digit year somewhere on the page.
    await expect(page.getByText(/\b\d{4}\b/).first()).toBeVisible();
  } finally {
    if (bookId) await admin.from("books").delete().eq("id", bookId);
    await cleanupUser(user.id);
  }
});
