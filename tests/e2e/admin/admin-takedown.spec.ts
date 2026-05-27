import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";

test("admin takedown clears description, locks refetch, writes audit row", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("admin-takedown", { isAdmin: true });

  const { data: row, error: insertErr } = await admin
    .from("book_catalog")
    .insert({
      isbn: "9780000000800",
      title: "Takedown spec book",
      author: "Takedown Author",
      description: "remove this text",
      description_provider: "google_books",
    })
    .select("id")
    .single();
  if (insertErr || !row) throw new Error(`seed failed: ${insertErr?.message}`);

  try {
    await login(page, user);
    await page.goto(`/app/admin/catalog/${row.id}`);
    await awaitHydration(page);

    await page.getByRole("button", { name: /takedown/i }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    const { data: after } = await admin
      .from("book_catalog")
      .select(
        "description, description_raw, description_provider, do_not_refetch_description",
      )
      .eq("id", row.id)
      .single();
    expect(after?.description).toBeNull();
    expect(after?.description_raw).toBeNull();
    expect(after?.description_provider).toBeNull();
    expect(after?.do_not_refetch_description).toBe(true);

    const { data: audit } = await admin
      .from("catalog_admin_actions")
      .select("action, admin_user_id, isbn")
      .eq("catalog_id", row.id);
    expect(audit).toHaveLength(1);
    expect(audit?.[0].action).toBe("takedown");
    expect(audit?.[0].admin_user_id).toBe(user.id);
    expect(audit?.[0].isbn).toBe("9780000000800");
  } finally {
    await admin.from("book_catalog").delete().eq("id", row.id);
    await cleanupUser(user.id);
  }
});
