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

  it("upload_cover writes storage cols + audit on full patch", async () => {
    const { data: auditId, error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "upload_cover",
      p_patch_jsonb: {
        storage_path: "ab/abc.jpg",
        cover_storage_backend: "cloudflare-images",
        image_sha256: "f".repeat(64),
        cover_max_width: 1200,
      },
    });
    expect(error).toBeNull();
    expect(auditId).toBeTruthy();

    const { data: row } = await admin
      .from("book_catalog")
      .select(
        "storage_path, cover_storage_backend, image_sha256, cover_max_width, cover_source, pending_storage, cover_fail_reason",
      )
      .eq("id", rowId)
      .single();
    expect(row?.storage_path).toBe("ab/abc.jpg");
    expect(row?.cover_storage_backend).toBe("cloudflare-images");
    expect(row?.image_sha256).toBe("f".repeat(64));
    expect(row?.cover_max_width).toBe(1200);
    expect(row?.cover_source).toBe("manual");
    expect(row?.pending_storage).toBe(false);
    expect(row?.cover_fail_reason).toBeNull();
  });

  it("upload_cover raises on empty patch (would null storage cols)", async () => {
    const { error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "upload_cover",
      p_patch_jsonb: {},
    });
    expect(error?.message).toMatch(
      /upload_cover requires non-null storage_path/i,
    );
  });

  it("upload_cover raises on partial patch (missing one required key)", async () => {
    const { error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "upload_cover",
      p_patch_jsonb: {
        storage_path: "cd/ef.jpg",
        cover_storage_backend: "supabase",
        image_sha256: "a".repeat(64),
        // cover_max_width missing
      },
    });
    expect(error?.message).toMatch(/cover_max_width/i);
  });

  it("set_isbn raises on null isbn in patch (would no-op promote with NULL)", async () => {
    const { data: taRow } = await admin
      .from("book_catalog")
      .insert({
        isbn: null,
        normalized_title_author: "set-isbn-null-probe|author",
        title: "Null Patch Probe",
        author: "Author",
      })
      .select("id")
      .single();

    const { error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: taRow!.id,
      p_action: "set_isbn",
      p_patch_jsonb: {},
    });
    expect(error?.message).toMatch(/set_isbn requires non-null isbn/i);

    // Row + audit unchanged.
    const { data: rowAfter } = await admin
      .from("book_catalog")
      .select("isbn")
      .eq("id", taRow!.id)
      .single();
    expect(rowAfter?.isbn).toBeNull();

    const { data: audits } = await admin
      .from("catalog_admin_actions")
      .select("id")
      .eq("catalog_id", taRow!.id);
    expect(audits ?? []).toHaveLength(0);
  });

  it("rejects non-admin p_admin_user_id (defense-in-depth gate)", async () => {
    const nonAdmin = await createTestUser("admin-apply-action-non-admin");
    try {
      const { error } = await admin.rpc("admin_apply_action", {
        p_admin_user_id: nonAdmin.id,
        p_catalog_id: rowId,
        p_action: "takedown",
        p_patch_jsonb: {},
      });
      expect(error?.message).toMatch(/is not an admin/i);

      const { data: rowAfter } = await admin
        .from("book_catalog")
        .select("description")
        .eq("id", rowId)
        .single();
      expect(rowAfter?.description).toBe("original description");

      const { data: audits } = await admin
        .from("catalog_admin_actions")
        .select("id")
        .eq("catalog_id", rowId);
      expect(audits ?? []).toHaveLength(0);
    } finally {
      await deleteTestUser(nonAdmin.id).catch(() => undefined);
    }
  });

  it("rejects unknown p_admin_user_id (no profiles row)", async () => {
    const { error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: "00000000-0000-0000-0000-000000000000",
      p_catalog_id: rowId,
      p_action: "takedown",
      p_patch_jsonb: {},
    });
    expect(error?.message).toMatch(/is not an admin/i);
  });

  it("requeue forwards fields to requeue_catalog_resolve + writes audit", async () => {
    await admin
      .from("book_catalog")
      .update({
        publisher: "Stale",
        publisher_provider: "openlibrary",
        publisher_attempted_at: new Date().toISOString(),
      })
      .eq("id", rowId);

    const { data: auditId, error } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: adminUserId,
      p_catalog_id: rowId,
      p_action: "requeue",
      p_patch_jsonb: { fields: ["publisher"] },
    });
    expect(error).toBeNull();
    expect(auditId).toBeTruthy();

    const { data: row } = await admin
      .from("book_catalog")
      .select("publisher, publisher_provider, publisher_attempted_at")
      .eq("id", rowId)
      .single();
    expect(row?.publisher).toBeNull();
    expect(row?.publisher_provider).toBeNull();
    expect(row?.publisher_attempted_at).toBeNull();

    const { data: audit } = await admin
      .from("catalog_admin_actions")
      .select("action")
      .eq("id", auditId as unknown as string)
      .single();
    expect(audit?.action).toBe("requeue");
  });
});
