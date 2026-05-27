import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getAdmin, shutdown } from "../helpers";

describe.skipIf(!process.env.INTEGRATION)("requeue_catalog_resolve RPC", () => {
  let admin: ReturnType<typeof getAdmin>;
  let rowId: string;

  beforeEach(async () => {
    admin = getAdmin();
    await admin.from("book_catalog").delete().not("id", "is", null);
    const { data, error } = await admin
      .from("book_catalog")
      .insert({
        isbn: "9780000000000",
        description: "old text",
        description_raw: "old text raw",
        description_provider: "google_books",
        description_attempted_at: new Date().toISOString(),
        description_fail_reason: null,
        do_not_refetch_description: true,
        publisher: "Old Publisher",
        publisher_provider: "openlibrary",
        publisher_attempted_at: new Date().toISOString(),
        subjects: ["fiction"],
      })
      .select("id")
      .single();
    if (error) throw error;
    rowId = data!.id;
  });

  afterAll(async () => {
    await shutdown();
  });

  it("nulls description value + state + clears takedown flag", async () => {
    const { error } = await admin.rpc("requeue_catalog_resolve", {
      p_id: rowId,
      p_fields: ["description"],
    });
    expect(error).toBeNull();

    const { data: after } = await admin
      .from("book_catalog")
      .select(
        "description, description_raw, description_provider, " +
          "description_attempted_at, description_fail_reason, " +
          "do_not_refetch_description, publisher, publisher_provider",
      )
      .eq("id", rowId)
      .single();

    expect(after?.description).toBeNull();
    expect(after?.description_raw).toBeNull();
    expect(after?.description_provider).toBeNull();
    expect(after?.description_attempted_at).toBeNull();
    expect(after?.description_fail_reason).toBeNull();
    expect(after?.do_not_refetch_description).toBe(false);
    // Other fields untouched.
    expect(after?.publisher).toBe("Old Publisher");
    expect(after?.publisher_provider).toBe("openlibrary");
  });

  it("flips pending_storage to TRUE when cover requeued", async () => {
    await admin
      .from("book_catalog")
      .update({
        storage_path: "ab/abc.jpg",
        cover_storage_backend: "supabase",
        image_sha256: "a".repeat(64),
        cover_max_width: 1200,
        cover_source: "openlibrary_isbn_direct",
        pending_storage: false,
      })
      .eq("id", rowId);

    await admin.rpc("requeue_catalog_resolve", {
      p_id: rowId,
      p_fields: ["cover"],
    });

    const { data: after } = await admin
      .from("book_catalog")
      .select(
        "storage_path, cover_storage_backend, image_sha256, " +
          "cover_max_width, cover_source, pending_storage",
      )
      .eq("id", rowId)
      .single();

    expect(after?.storage_path).toBeNull();
    expect(after?.cover_storage_backend).toBeNull();
    expect(after?.image_sha256).toBeNull();
    expect(after?.cover_max_width).toBeNull();
    expect(after?.cover_source).toBeNull();
    expect(after?.pending_storage).toBe(true);
  });

  it("rejects unknown field name with RAISE", async () => {
    const { error } = await admin.rpc("requeue_catalog_resolve", {
      p_id: rowId,
      p_fields: ["bogus_field"],
    });
    expect(error?.message).toMatch(/unknown field/i);
  });
});
