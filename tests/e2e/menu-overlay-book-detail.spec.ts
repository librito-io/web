import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "./helpers/auth";
import { awaitHydration } from "./helpers/hydrate";
import { getAdmin } from "./helpers/supabase";

// Regression: the menu overlay must paint ABOVE page content on the book
// detail route. The page wraps its book info in a semantic
// `<header class="book-header">`; the global `header { position: sticky;
// z-index: 60 }` rule (meant for the SITE header) leaked onto it, lifting
// the book header above the overlay's `z-index: 50` so the cover/title/
// description painted over the open menu. See the screenshot in the bug
// report — content over the menu top, menu items peeking out below.
test("book-detail menu overlay paints above the book header", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("menu-overlay-book");
  // book_hash is CHECK-constrained to ^[0-9a-f]{8}$ (FNV-1a device hash).
  const bookHash = (Date.now() % 0xffffffff).toString(16).padStart(8, "0");
  let bookId: string | null = null;
  try {
    const { data: book, error: bErr } = await admin
      .from("books")
      .insert({
        user_id: user.id,
        book_hash: bookHash,
        title: "Overlay Stacking Fixture",
        author: "Test Author",
      })
      .select("id")
      .single();
    if (bErr || !book) throw new Error(`seed books: ${bErr?.message}`);
    bookId = book.id;

    await login(page, user);
    await page.goto(`/app/book/${bookHash}`);
    await awaitHydration(page);

    // The book header (cover + title) must be on screen so the overlap is real.
    const bookHeader = page.locator(".book-header");
    await expect(bookHeader).toBeVisible();

    // Open the menu.
    await page.locator("button.menu-btn").click();

    const overlay = page.locator("#menuOverlay");
    // Overlay animates open (height transition). Wait until it has real height.
    await expect
      .poll(async () =>
        overlay.evaluate((el) => Math.round(el.getBoundingClientRect().height)),
      )
      .toBeGreaterThan(100);

    // At a point over the book-header region, the topmost painted element
    // must belong to the overlay — not the book content underneath.
    const topElInOverlay = await page.evaluate(() => {
      const bh = document.querySelector(".book-header");
      const ov = document.getElementById("menuOverlay");
      if (!bh || !ov) return null;
      const r = bh.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + Math.min(r.height / 2, 100));
      const el = document.elementFromPoint(x, y);
      return el ? ov.contains(el) : null;
    });

    expect(topElInOverlay).toBe(true);
  } finally {
    if (bookId) await admin.from("books").delete().eq("id", bookId);
    await cleanupUser(user.id);
  }
});
