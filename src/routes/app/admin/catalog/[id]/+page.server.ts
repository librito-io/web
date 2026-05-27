import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { requireUser } from "$lib/server/auth";
import { createAdminClient } from "$lib/server/supabase";
import { uploadCover } from "$lib/server/cover-storage";
import { decodeImageDimensions } from "$lib/server/catalog/dimensions";
import { runInBackground } from "$lib/server/wait-until";
import {
  scheduleCatalogResolveIfAllowed,
  type CatalogResolveWork,
} from "$lib/server/catalog/scheduling";
import { SERVICE_USER_ID } from "$lib/server/catalog/constants";
import { TRACKED_FIELDS } from "$lib/catalog/tracked-fields";

const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const load: PageServerLoad = async ({ params }) => {
  const admin = createAdminClient();
  const { data: row, error: err } = await admin
    .from("book_catalog")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (err) error(500, err.message);
  if (!row) error(404, "catalog row not found");
  return { row };
};

export const actions: Actions = {
  saveDescription: async (event) => {
    const user = requireUser(event);
    const fd = await event.request.formData();
    const description = String(fd.get("description") ?? "").trim();
    if (!description) return fail(400, { message: "description required" });
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: event.params.id,
      p_action: "save_description",
      p_patch_jsonb: { description },
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
  },

  takedown: async (event) => {
    const user = requireUser(event);
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: event.params.id,
      p_action: "takedown",
      p_patch_jsonb: {},
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
  },

  uploadCover: async (event) => {
    const user = requireUser(event);
    const fd = await event.request.formData();
    const file = fd.get("cover");
    if (!(file instanceof File)) {
      return fail(400, { message: "cover file required" });
    }
    if (file.size > COVER_MAX_BYTES) {
      return fail(400, { message: `max ${COVER_MAX_BYTES} bytes` });
    }
    if (!COVER_MIMES.has(file.type)) {
      return fail(400, {
        message: `mime must be one of ${[...COVER_MIMES].join(", ")}`,
      });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const dims = decodeImageDimensions(bytes);
    if (!dims) return fail(400, { message: "could not decode image" });

    const upload = await uploadCover(bytes, file.type, {});
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: event.params.id,
      p_action: "upload_cover",
      p_patch_jsonb: {
        storage_path: upload.storage_path,
        cover_storage_backend: upload.backend,
        image_sha256: upload.image_sha256,
        cover_max_width: dims.width,
      },
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
  },

  setIsbn: async (event) => {
    const user = requireUser(event);
    const fd = await event.request.formData();
    const isbn = String(fd.get("isbn") ?? "").trim();
    if (!isbn) return fail(400, { message: "isbn required" });
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: event.params.id,
      p_action: "set_isbn",
      p_patch_jsonb: { isbn },
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
  },

  requeue: async (event) => {
    const user = requireUser(event);
    const fd = await event.request.formData();
    const fields = TRACKED_FIELDS.filter((f) => fd.get(`field_${f}`) === "on");
    if (fields.length === 0) {
      return fail(400, { message: "select at least one field" });
    }

    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: event.params.id,
      p_action: "requeue",
      p_patch_jsonb: { fields },
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });

    // Kick off the background re-resolve so the operator sees fresh
    // provider data within seconds. Errors absorbed by runInBackground.
    const { data: row } = await admin
      .from("book_catalog")
      .select("isbn, title, author, normalized_title_author")
      .eq("id", event.params.id)
      .maybeSingle();
    if (row) {
      const ctx =
        row.title && row.author
          ? { title: row.title, author: row.author }
          : undefined;
      const work: CatalogResolveWork[] = row.isbn
        ? [{ kind: "isbn", isbn: row.isbn, ctx, fields }]
        : row.title && row.author
          ? [{ kind: "ta", title: row.title, author: row.author, fields }]
          : [];
      if (work.length > 0) {
        runInBackground(() =>
          scheduleCatalogResolveIfAllowed(SERVICE_USER_ID, work, {
            bypassUserLimit: true,
          }),
        );
      }
    }

    return { ok: true };
  },
};
