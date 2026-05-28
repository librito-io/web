import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";

test("admin promotes TA-keyed catalog row to ISBN via Set ISBN form", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("admin-set-isbn", { isAdmin: true });
  let rowId: string | null = null;
  try {
    const { data: row, error: seedErr } = await admin
      .from("book_catalog")
      .insert({
        isbn: null,
        normalized_title_author: "promote-via-ui|author",
        title: "Promote via UI",
        author: "Author",
      })
      .select("id")
      .single();
    if (seedErr || !row) {
      throw new Error(`seed failed: ${seedErr?.message ?? "no row returned"}`);
    }
    rowId = row.id;

    await login(page, user);
    await page.goto(`/app/admin/catalog/${row.id}`);
    await awaitHydration(page);

    await page.getByLabel("ISBN").fill("9780000000802");
    await page.getByRole("button", { name: /set isbn/i }).click();

    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    const { data: after } = await admin
      .from("book_catalog")
      .select("isbn, normalized_title_author")
      .eq("id", row.id)
      .single();
    expect(after?.isbn).toBe("9780000000802");

    const { data: audit } = await admin
      .from("catalog_admin_actions")
      .select("action, admin_user_id, isbn")
      .eq("catalog_id", row.id);
    expect(audit).toHaveLength(1);
    expect(audit?.[0].action).toBe("set_isbn");
    expect(audit?.[0].admin_user_id).toBe(user.id);
    // The audit RPC captures `isbn` from `v_after->>'isbn'`, which is
    // the post-promote ISBN.
    expect(audit?.[0].isbn).toBe("9780000000802");
  } finally {
    if (rowId) {
      await admin.from("book_catalog").delete().eq("id", rowId);
    }
    await cleanupUser(user.id);
  }
});
