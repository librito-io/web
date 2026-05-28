import { test, expect } from "@playwright/test";
import { createE2EUser, cleanupUser, login } from "../helpers/auth";
import { awaitHydration } from "../helpers/hydrate";
import { getAdmin } from "../helpers/supabase";

test("admin DLQ archive section renders and manual requeue stamps manually_requeued_at", async ({
  page,
}) => {
  const admin = getAdmin();
  const user = await createE2EUser("admin-dlq", { isAdmin: true });
  let catalogId: string | null = null;
  let archiveRowId: number | null = null;
  try {
    // Synthetic ISBN that providers will not resolve, matching the pattern
    // used in the other admin specs. isbn key drives the DLQ lookup via
    // payload->item->>isbn in the load function.
    const { data: catalogRow, error: catalogErr } = await admin
      .from("book_catalog")
      .insert({
        isbn: "9780000000901",
        title: "DLQ E2E Book",
        author: "DLQ Author",
      })
      .select("id")
      .single();
    if (catalogErr || !catalogRow) {
      throw new Error(`catalog seed failed: ${catalogErr?.message}`);
    }
    catalogId = catalogRow.id;

    // Insert a matching DLQ archive row. payload.item.isbn must match
    // catalogRow.isbn for the load query to surface it on the admin page.
    const { data: archiveRow, error: archiveErr } = await admin
      .from("catalog_dlq_archive")
      .insert({
        message_id: `msg-e2e-dlq-${Date.now()}`,
        payload: {
          userId: "e2e-user",
          item: { kind: "isbn", isbn: "9780000000901" },
        },
        first_failed_at: new Date().toISOString(),
        fail_reason: "exhausted",
      })
      .select("id")
      .single();
    if (archiveErr || !archiveRow) {
      throw new Error(`archive seed failed: ${archiveErr?.message}`);
    }
    archiveRowId = archiveRow.id;

    await login(page, user);
    await page.goto(`/app/admin/catalog/${catalogId}`);
    await awaitHydration(page);

    // DLQ section heading must include the count
    await expect(page.getByText("DLQ archive (1)")).toBeVisible();

    // The archive row must render in the table
    await expect(page.getByTestId(`dlq-row-${archiveRowId}`)).toBeVisible();

    // manually_requeued_at is null — rendered as "—" in the last <td>
    await expect(
      page.getByTestId(`dlq-row-${archiveRowId}`).locator("td").last(),
    ).toHaveText("—");

    // Submit the requeue form with the "cover" field checked
    await page.getByRole("checkbox", { name: "cover" }).check();
    await page.getByRole("button", { name: /requeue selected/i }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    // Verify DB: manually_requeued_at is stamped synchronously by the
    // requeue action before returning "Saved.", so no wait is needed.
    const { data: stamped } = await admin
      .from("catalog_dlq_archive")
      .select("manually_requeued_at")
      .eq("id", archiveRowId)
      .single();
    expect(stamped?.manually_requeued_at).not.toBeNull();
  } finally {
    if (archiveRowId !== null) {
      await admin.from("catalog_dlq_archive").delete().eq("id", archiveRowId);
    }
    if (catalogId !== null) {
      await admin.from("book_catalog").delete().eq("id", catalogId);
    }
    await cleanupUser(user.id);
  }
});
