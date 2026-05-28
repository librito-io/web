import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";

test("admin upload cover persists storage_path, source=manual, writes audit row", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("admin-cover-upload", { isAdmin: true });

  // Declared outside try so the finally block can reach it even if seed fails
  // after the user has been created.
  let rowId: string | null = null;

  try {
    const { data: row, error: insertErr } = await admin
      .from("book_catalog")
      .insert({
        isbn: "9780000000801",
        title: "Cover upload spec book",
        author: "Cover Upload Author",
      })
      .select("id")
      .single();
    if (insertErr || !row)
      throw new Error(`seed failed: ${insertErr?.message}`);
    rowId = row.id;

    await login(page, user);
    await page.goto(`/app/admin/catalog/${rowId}`);
    await awaitHydration(page);

    // Locate via the input selector — the file input is wrapped by a <label>
    // but has no explicit aria-label, so getByLabel can be brittle if copy
    // shifts. input[type="file"][name="cover"] is the load-bearing contract
    // the form action depends on.
    await page
      .locator('input[type="file"][name="cover"]')
      .setInputFiles("tests/e2e/fixtures/sample-cover.jpg");
    await page.getByRole("button", { name: /upload cover/i }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    const { data: after } = await admin
      .from("book_catalog")
      .select(
        "storage_path, cover_storage_backend, image_sha256, cover_source, cover_max_width",
      )
      .eq("id", rowId)
      .single();
    expect(after?.storage_path).toBeTruthy();
    expect(after?.cover_source).toBe("manual");
    expect(after?.cover_max_width).toBe(300);
    expect(after?.image_sha256).toMatch(/^[a-f0-9]{64}$/);

    const { data: audit } = await admin
      .from("catalog_admin_actions")
      .select("action, admin_user_id, isbn")
      .eq("catalog_id", rowId);
    expect(audit).toHaveLength(1);
    expect(audit?.[0].action).toBe("upload_cover");
    expect(audit?.[0].admin_user_id).toBe(user.id);
  } finally {
    if (rowId) {
      const { data: r } = await admin
        .from("book_catalog")
        .select("storage_path, cover_storage_backend, image_sha256")
        .eq("id", rowId)
        .maybeSingle();
      if (r?.storage_path && r.cover_storage_backend === "supabase") {
        // Local dev uses Supabase backend. Remove the uploaded object so
        // re-runs of this spec against the same sha don't conflict on the
        // sha-keyed path. Cloudflare backend dedups by sha so leaving objects
        // is benign there.
        await admin.storage.from("cover-cache").remove([r.storage_path]);
      }
      await admin.from("book_catalog").delete().eq("id", rowId);
    }
    await cleanupUser(user.id);
  }
});
