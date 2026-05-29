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
// Proves the book-detail page (/app/book/[hash]) renders cover +
// description + metadata for a catalog-populated book, and degrades
// gracefully when the row carries no cover / description. Hermetic: rows +
// cover bytes seeded directly via the admin client (no resolver, no live
// upstreams).

async function seedBook(
  admin: ReturnType<typeof getAdmin>,
  userId: string,
  key: FixtureKey,
): Promise<string> {
  const fix = FIXTURES[key];
  await seedCatalogRow(key);
  const bookHash = `${key.replace(/[^0-9a-f]/g, "")}`
    .padEnd(8, "0")
    .slice(0, 8);
  const { data: book, error } = await admin
    .from("books")
    .insert({
      user_id: userId,
      book_hash: bookHash,
      title: fix.title,
      author: fix.author,
      isbn: fix.isbn ?? null,
    })
    .select("id, book_hash")
    .single();
  if (error || !book) throw new Error(`seed books: ${error?.message}`);
  return book.book_hash;
}

test("book detail renders cover + description + metadata for a populated row", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("book-detail-full");
  const fix = FIXTURES["isbn-full"];
  let bookHash: string | null = null;
  try {
    bookHash = await seedBook(admin, user.id, "isbn-full");

    await login(page, user);
    await page.goto(`/app/book/${bookHash}`);
    await awaitHydration(page);

    await expect(page.getByText(fix.title, { exact: true })).toBeVisible();

    // Cover image decoded from the seeded storage URL (not the placeholder).
    const cover = page.locator("img.book-cover");
    await expect(cover).toBeVisible();
    const src = await cover.getAttribute("src");
    expect(src).not.toContain("cover-placeholder");
    const decoded = await cover.evaluate(
      (el) =>
        el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0,
    );
    expect(decoded, "cover image decoded").toBe(true);

    // Description + published date render.
    await expect(page.locator(".catalog-description")).toBeVisible();
    expect(fix.published_date, "fixture has published_date").not.toBeNull();
    await expect(page.locator(".catalog-line")).toContainText(
      fix.published_date!,
    );
  } finally {
    if (bookHash) {
      await admin
        .from("books")
        .delete()
        .eq("user_id", user.id)
        .eq("book_hash", bookHash);
    }
    await cleanupUser(user.id);
  }
});

test("book detail degrades gracefully when the row has no cover or description", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("book-detail-partial");
  const fix = FIXTURES["isbn-partial"];
  let bookHash: string | null = null;
  try {
    bookHash = await seedBook(admin, user.id, "isbn-partial");

    await login(page, user);
    await page.goto(`/app/book/${bookHash}`);
    await awaitHydration(page);

    // Page renders (no crash) — title is present.
    await expect(page.getByText(fix.title, { exact: true })).toBeVisible();

    // Missing cover falls back to the placeholder asset, not a broken image.
    const src = await page.locator("img.book-cover").getAttribute("src");
    expect(src).toContain("cover-placeholder");

    // No description block when the row carries no description.
    await expect(page.locator(".catalog-description")).toHaveCount(0);
  } finally {
    if (bookHash) {
      await admin
        .from("books")
        .delete()
        .eq("user_id", user.id)
        .eq("book_hash", bookHash);
    }
    await cleanupUser(user.id);
  }
});
