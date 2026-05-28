import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";

test("admin requeue clears description field state and writes audit row", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("admin-requeue", { isAdmin: true });
  let rowId: string | null = null;
  try {
    // Synthetic ISBN that providers (OL / GB / iTunes) will not resolve.
    // The form action fires `runInBackground(scheduleCatalogResolveIfAllowed)`
    // after the synchronous RPC mutation; using an ISBN that no provider
    // will repopulate bounds the race window. See spec brief.
    const { data: row, error: seedErr } = await admin
      .from("book_catalog")
      .insert({
        isbn: "9780000000803",
        title: "Requeue spec book",
        author: "Requeue Author",
        description: "stale text",
        description_provider: "google_books",
        description_attempted_at: new Date().toISOString(),
        description_fail_reason: null,
        do_not_refetch_description: true,
      })
      .select("id")
      .single();
    if (seedErr || !row) {
      throw new Error(`seed failed: ${seedErr?.message}`);
    }
    rowId = row.id;

    await login(page, user);
    await page.goto(`/app/admin/catalog/${row.id}`);
    await awaitHydration(page);

    // `getByLabel("description")` clashes with the description textarea
    // (aria-label="Description") — disambiguate via role.
    await page.getByRole("checkbox", { name: "description" }).check();
    await page.getByRole("button", { name: /requeue selected/i }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    // Assert DB state IMMEDIATELY — `admin_apply_action` runs synchronously
    // before the form action returns "Saved.", but the background resolver
    // kicked off via `runInBackground` may race afterwards. No `waitFor`.
    const { data: after } = await admin
      .from("book_catalog")
      .select(
        "description, description_provider, description_attempted_at, do_not_refetch_description",
      )
      .eq("id", row.id)
      .single();
    expect(after?.description).toBeNull();
    expect(after?.description_provider).toBeNull();
    expect(after?.description_attempted_at).toBeNull();
    expect(after?.do_not_refetch_description).toBe(false);

    // Background resolve does NOT write to `catalog_admin_actions` —
    // only admin actions populate that table — so exactly one row is
    // expected here.
    const { data: audit } = await admin
      .from("catalog_admin_actions")
      .select("action, admin_user_id")
      .eq("catalog_id", row.id);
    expect(audit).toHaveLength(1);
    expect(audit?.[0].action).toBe("requeue");
    expect(audit?.[0].admin_user_id).toBe(user.id);
  } finally {
    if (rowId) {
      await admin.from("book_catalog").delete().eq("id", rowId);
    }
    await cleanupUser(user.id);
  }
});
