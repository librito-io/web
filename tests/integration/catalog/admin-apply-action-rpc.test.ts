import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getAdmin, shutdown, createTestUser, deleteTestUser } from "../helpers";

describe.skipIf(!process.env.INTEGRATION)("admin_apply_action RPC", () => {
  let admin: ReturnType<typeof getAdmin>;
  let adminUserId: string;
  let rowId: string;

  beforeEach(async () => {
    admin = getAdmin();
    await admin.from("catalog_admin_actions").delete().not("id", "is", null);
    await admin.from("book_catalog").delete().not("id", "is", null);

    const user = await createTestUser("admin-apply-action");
    adminUserId = user.id;
    await admin
      .from("profiles")
      .update({ is_admin: true })
      .eq("id", adminUserId);

    const { data: row } = await admin
      .from("book_catalog")
      .insert({
        isbn: "9780000000100",
        title: "Sample Book",
        author: "Some Author",
        description: "original description",
        description_provider: "google_books",
      })
      .select("id")
      .single();
    rowId = row!.id;
  });

  afterAll(async () => {
    if (adminUserId) await deleteTestUser(adminUserId).catch(() => undefined);
    await shutdown();
  });

  it("save_description writes manual provider + audit row with snapshots", async () => {
    const { data: auditId, error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "save_description",
      p_patch_jsonb: { description: "edited by operator" },
    });
    expect(error).toBeNull();
    expect(auditId).toBeTruthy();

    const { data: row } = await admin
      .from("book_catalog")
      .select(
        "description, description_provider, do_not_refetch_description, description_fail_reason",
      )
      .eq("id", rowId)
      .single();
    expect(row?.description).toBe("edited by operator");
    expect(row?.description_provider).toBe("manual");
    expect(row?.do_not_refetch_description).toBe(true);
    expect(row?.description_fail_reason).toBeNull();

    const { data: audit } = await admin
      .from("catalog_admin_actions")
      .select("*")
      .eq("id", auditId as unknown as string)
      .single();
    expect(audit?.action).toBe("save_description");
    expect(audit?.admin_user_id).toBe(adminUserId);
    expect(audit?.catalog_id).toBe(rowId);
    expect(audit?.isbn).toBe("9780000000100");
    expect((audit?.before_jsonb as { description: string }).description).toBe(
      "original description",
    );
    expect((audit?.after_jsonb as { description: string }).description).toBe(
      "edited by operator",
    );
  });

  it("takedown nulls description fields + sets do_not_refetch_description", async () => {
    await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "takedown",
      p_patch_jsonb: {},
    });
    const { data: row } = await admin
      .from("book_catalog")
      .select(
        "description, description_raw, description_provider, do_not_refetch_description",
      )
      .eq("id", rowId)
      .single();
    expect(row?.description).toBeNull();
    expect(row?.description_raw).toBeNull();
    expect(row?.description_provider).toBeNull();
    expect(row?.do_not_refetch_description).toBe(true);
  });

  it("set_isbn raises on row already carrying isbn", async () => {
    const { error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "set_isbn",
      p_patch_jsonb: { isbn: "9780000000999" },
    });
    expect(error?.message).toMatch(/requires TA-keyed row/i);
  });

  it("set_isbn succeeds on TA-keyed row; audit captures new isbn", async () => {
    const { data: taRow } = await admin
      .from("book_catalog")
      .insert({
        isbn: null,
        normalized_title_author: "promote-me|author",
        title: "Promote Me",
        author: "Author",
      })
      .select("id")
      .single();

    const { data: auditId, error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: taRow!.id,
      p_action: "set_isbn",
      p_patch_jsonb: { isbn: "9780000000500" },
    });
    expect(error).toBeNull();

    const { data: promoted } = await admin
      .from("book_catalog")
      .select("isbn")
      .eq("id", taRow!.id)
      .single();
    expect(promoted?.isbn).toBe("9780000000500");

    const { data: audit } = await admin
      .from("catalog_admin_actions")
      .select("isbn, after_jsonb")
      .eq("id", auditId as unknown as string)
      .single();
    expect(audit?.isbn).toBe("9780000000500");
    expect((audit?.after_jsonb as { isbn: string }).isbn).toBe("9780000000500");
  });

  it("rejects unknown action", async () => {
    const { error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "delete_everything",
      p_patch_jsonb: {},
    });
    expect(error?.message).toMatch(/unknown admin action/i);
  });

  it("raises when catalog row not found", async () => {
    const { error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: "00000000-0000-0000-0000-000000000000",
      p_action: "takedown",
      p_patch_jsonb: {},
    });
    expect(error?.message).toMatch(/catalog row not found/i);
  });
});
