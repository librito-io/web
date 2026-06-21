import { test, expect, type Page } from "@playwright/test";
import {
  createE2EUser,
  cleanupUser,
  login,
  type E2EUser,
} from "./helpers/auth";
import { getAdmin } from "./helpers/supabase";
import { awaitHydration } from "./helpers/hydrate";

let user: E2EUser;
let bookId: string;

async function seedBook(userId: string): Promise<string> {
  const admin = getAdmin();
  const { data, error } = await admin
    .from("books")
    .insert({
      user_id: userId,
      // book_hash must match the valid_book_hash CHECK: ^[0-9a-f]{8}$ (FNV-1a
      // 8-hex). The plan's "live0001" fails it (l/i/v aren't hex) — fixture fix.
      book_hash: "11fe0001",
      title: "Live Feed Book",
      author: "Author",
      isbn: null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedBook: ${error?.message}`);
  return data.id as string;
}

// Seed one kobo highlight. created_at controls 'recent' order; pass an explicit
// ISO string to place a row deep in the list.
async function seedHighlight(
  userId: string,
  text: string,
  createdAt: string,
): Promise<string> {
  const admin = getAdmin();
  const { data, error } = await admin
    .from("highlights")
    .insert({
      book_id: bookId,
      user_id: userId,
      source: "kobo",
      source_uid: `uid-${text}`,
      text,
      created_at: createdAt,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedHighlight: ${error?.message}`);
  return data.id as string;
}

// Wait until the live channel reports SUBSCRIBED (component sets this on the
// <html> element). Inserts fired before SUBSCRIBED are lost — Broadcast has no
// backlog — so a deterministic wait beats a fixed sleep.
async function awaitLiveFeed(page: Page): Promise<void> {
  await page
    .locator("html[data-live-feed='subscribed']")
    .waitFor({ state: "attached", timeout: 10_000 });
}

test.beforeEach(async () => {
  user = await createE2EUser("live-feed");
  bookId = await seedBook(user.id);
});

test.afterEach(async () => {
  await cleanupUser(user.id);
});

test("a newly inserted highlight appears live without refresh", async ({
  page,
}) => {
  await seedHighlight(user.id, "SEED-EXISTING", "2026-06-01T00:00:00Z");
  await login(page, user);
  await page.goto("/app");
  await awaitHydration(page);
  await awaitLiveFeed(page);

  // Insert AFTER the channel is subscribed → broadcast → debounced head
  // refetch → card appears.
  await seedHighlight(user.id, "NEW-LIVE-INSERT", "2026-06-21T12:00:00Z");

  await expect(page.getByText("NEW-LIVE-INSERT", { exact: true })).toBeVisible({
    timeout: 8000,
  });
});

test("a soft-deleted highlight vanishes live (proves payload.id ↔ highlight_id splice)", async ({
  page,
}) => {
  const id = await seedHighlight(
    user.id,
    "TO-BE-TRASHED",
    "2026-06-10T00:00:00Z",
  );
  await login(page, user);
  await page.goto("/app");
  await awaitHydration(page);
  await awaitLiveFeed(page);
  await expect(page.getByText("TO-BE-TRASHED", { exact: true })).toBeVisible();

  // Admin-flip deleted_at (no trash UI yet — web#530). Broadcast → splice.
  const { error } = await getAdmin()
    .from("highlights")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  expect(error).toBeNull();

  await expect(page.getByText("TO-BE-TRASHED", { exact: true })).toHaveCount(
    0,
    {
      timeout: 8000,
    },
  );
});

test("restoring a deep highlight reappears live (full-range refetch, not head-only)", async ({
  page,
}) => {
  // Seed 60 newer rows + one OLDEST target. Target is older than 50 others, so
  // a head-only refetch (top 50) could never reintroduce it after a splice —
  // only the full-loaded-range refetch can. This is the H1/H4 guard.
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, "0");
    await seedHighlight(user.id, `FILLER-${n}`, `2026-06-2${0}T00:${n}:00Z`);
  }
  const targetId = await seedHighlight(
    user.id,
    "OLDEST-RESTORE-TARGET",
    "2020-01-01T00:00:00Z",
  );

  await login(page, user);
  await page.goto("/app");
  await awaitHydration(page);
  await awaitLiveFeed(page);

  // Scroll to load the deep target into the rendered window (initial page = 50).
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, 6000);
        return page.getByText("OLDEST-RESTORE-TARGET", { exact: true }).count();
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // Trash it → splice removes it from the loaded set.
  await getAdmin()
    .from("highlights")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", targetId);
  await expect(
    page.getByText("OLDEST-RESTORE-TARGET", { exact: true }),
  ).toHaveCount(0, { timeout: 8000 });

  // Restore → full-loaded-range refetch reintroduces it at its deep position.
  await getAdmin()
    .from("highlights")
    .update({ deleted_at: null })
    .eq("id", targetId);
  await expect(
    page.getByText("OLDEST-RESTORE-TARGET", { exact: true }),
  ).toHaveCount(1, { timeout: 10_000 });
});
