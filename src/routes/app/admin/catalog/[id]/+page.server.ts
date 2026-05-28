import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdmin, requireUuidParam } from "$lib/server/auth";
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
import { logger } from "$lib/server/log";

const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
// Multi-MB description bodies would bloat both the row and the
// catalog_admin_actions before/after JSONB snapshots (~2 KB per row
// becomes ~MB if uncapped). 8 KB is generous for hand-edited blurbs.
const DESCRIPTION_MAX_CHARS = 8 * 1024;
// ISBN-10 (9 digits + check) or ISBN-13 (978/979 prefix + 9 digits +
// check). Check char may be 'X' on ISBN-10. Stored as text, validated
// at the boundary so a setIsbn slip can't write arbitrary strings into
// the catalog key.
const ISBN_RE = /^(?:97[89])?\d{9}[\dX]$/i;

export const load: PageServerLoad = async ({ params }) => {
  const id = requireUuidParam(params.id);
  const admin = createAdminClient();
  const { data: row, error: err } = await admin
    .from("book_catalog")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (err) error(500, err.message);
  if (!row) error(404, "catalog row not found");

  // Find matching DLQ archive rows. Two lookup paths matching the producer's
  // payload shape: ISBN-keyed (payload.item.isbn) or TA-keyed
  // (payload.item.title + payload.item.author). A DLQ entry can satisfy both
  // when the producer published an ISBN payload whose row also has a
  // (title, author) — dedupe by id to keep Svelte's keyed {#each} happy and
  // to keep the row list at one entry per DLQ record.
  //
  // Lookup limited to 50 per branch — surface bounded; older entries
  // inspectable via Supabase Studio if needed.

  type DlqArchiveRow = {
    id: number;
    message_id: string;
    first_failed_at: string;
    fail_reason: string | null;
    archived_at: string;
    manually_requeued_at: string | null;
    payload: unknown;
  };
  const DLQ_COLS =
    "id, message_id, first_failed_at, fail_reason, archived_at, manually_requeued_at, payload";

  const dlqQueries = [] as Promise<{
    data: DlqArchiveRow[] | null;
    error: unknown;
  }>[];
  if (row.isbn) {
    dlqQueries.push(
      admin
        .from("catalog_dlq_archive")
        .select(DLQ_COLS)
        .filter("payload->item->>isbn", "eq", row.isbn)
        .order("archived_at", { ascending: false })
        .limit(50) as unknown as Promise<{
        data: DlqArchiveRow[] | null;
        error: unknown;
      }>,
    );
  }
  if (row.title && row.author) {
    dlqQueries.push(
      admin
        .from("catalog_dlq_archive")
        .select(DLQ_COLS)
        .filter("payload->item->>title", "eq", row.title)
        .filter("payload->item->>author", "eq", row.author)
        .order("archived_at", { ascending: false })
        .limit(50) as unknown as Promise<{
        data: DlqArchiveRow[] | null;
        error: unknown;
      }>,
    );
  }
  const dlqResults = await Promise.all(dlqQueries);
  for (const r of dlqResults) {
    if (r.error) {
      logger().error(
        { event: "admin.catalog.dlq_lookup_failed", error: String(r.error) },
        "admin.catalog.dlq_lookup_failed",
      );
    }
  }
  const dlqArchive: DlqArchiveRow[] = Array.from(
    new Map(
      dlqResults.flatMap((r) => r.data ?? []).map((r) => [r.id, r]),
    ).values(),
  );

  return { row, dlqArchive };
};

export const actions: Actions = {
  saveDescription: async (event) => {
    const user = await requireAdmin(event);
    const id = requireUuidParam(event.params.id);
    const fd = await event.request.formData();
    const description = String(fd.get("description") ?? "").trim();
    if (!description) return fail(400, { message: "description required" });
    if (description.length > DESCRIPTION_MAX_CHARS) {
      return fail(400, {
        message: `description exceeds ${DESCRIPTION_MAX_CHARS} chars`,
      });
    }
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: id,
      p_action: "save_description",
      p_patch_jsonb: { description },
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
  },

  takedown: async (event) => {
    const user = await requireAdmin(event);
    const id = requireUuidParam(event.params.id);
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: id,
      p_action: "takedown",
      p_patch_jsonb: {},
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
  },

  uploadCover: async (event) => {
    const user = await requireAdmin(event);
    const id = requireUuidParam(event.params.id);
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
    return uploadCoverAction(user.id, id, file);
  },

  setIsbn: async (event) => {
    const user = await requireAdmin(event);
    const id = requireUuidParam(event.params.id);
    const fd = await event.request.formData();
    const isbn = String(fd.get("isbn") ?? "").trim();
    if (!isbn) return fail(400, { message: "isbn required" });
    if (!ISBN_RE.test(isbn)) {
      return fail(400, {
        message: "isbn must be ISBN-10 or ISBN-13 (digits only, no hyphens)",
      });
    }
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: id,
      p_action: "set_isbn",
      p_patch_jsonb: { isbn },
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
  },

  requeue: async (event) => {
    const user = await requireAdmin(event);
    const id = requireUuidParam(event.params.id);
    const fd = await event.request.formData();
    const fields = TRACKED_FIELDS.filter((f) => fd.get(`field_${f}`) === "on");
    if (fields.length === 0) {
      return fail(400, { message: "select at least one field" });
    }

    // Read the DLQ archive IDs the operator saw on this page (passed via
    // hidden inputs in the requeue form). Used to scope the stamp UPDATE to
    // only the rows the operator actually reviewed, preventing cross-catalog
    // contamination during set_isbn races.
    const dlqArchiveIds = fd
      .getAll("dlq_archive_id")
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));

    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("admin_apply_action", {
      p_admin_user_id: user.id,
      p_catalog_id: id,
      p_action: "requeue",
      p_patch_jsonb: { fields },
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });

    // Kick off the background re-resolve so the operator sees fresh
    // provider data within seconds. Errors absorbed by runInBackground.
    // When the row has neither an ISBN nor a usable title+author pair,
    // there's nothing for the resolver to do — surface that to the UI
    // so the operator can see "requeue stored, no resolve scheduled".
    const { data: row } = await admin
      .from("book_catalog")
      .select("isbn, title, author, normalized_title_author")
      .eq("id", id)
      .maybeSingle();

    // ctx must come from a device-synced `books` row, NOT from
    // `book_catalog.title`/`.author`. The catalog row is precisely what
    // requeue is correcting; reading ctx off it would loop a stub
    // ("Untitled MJ" / "To Be Confirmed Gallery" for pre-pub ISBN
    // 9781668082461) back into the resolver, which then "overrides"
    // upstream metadata with the same stub via the issue #449 fix —
    // no-op. The `books` table carries the EPUB-extracted title/author
    // from device sync; that's the authoritative source. Issue #449
    // follow-up.
    let ctx: { title: string; author: string } | undefined;
    if (row?.isbn) {
      const { data: book } = await admin
        .from("books")
        .select("title, author")
        .eq("isbn", row.isbn)
        .not("title", "is", null)
        .not("author", "is", null)
        .limit(1)
        .maybeSingle();
      if (book?.title && book.author) {
        ctx = { title: book.title, author: book.author };
      }
    }

    let work: CatalogResolveWork[] = [];
    if (row?.isbn) {
      work = [{ kind: "isbn", isbn: row.isbn, ctx, fields }];
    } else if (row?.title && row.author) {
      work = [{ kind: "ta", title: row.title, author: row.author, fields }];
    }
    if (work.length > 0) {
      runInBackground(() =>
        scheduleCatalogResolveIfAllowed(SERVICE_USER_ID, work, {
          bypassUserLimit: true,
        }),
      );

      // Stamp ONLY the DLQ rows the operator actually saw on this page.
      // Scoping to dlqArchiveIds prevents touching DLQ rows that belong to
      // a different catalog row sharing the same ISBN (transient state
      // during set_isbn races, partial-unique constraint window).
      if (dlqArchiveIds.length > 0) {
        const { error: stampErr } = await admin
          .from("catalog_dlq_archive")
          .update({ manually_requeued_at: new Date().toISOString() })
          .is("manually_requeued_at", null)
          .in("id", dlqArchiveIds);
        if (stampErr) {
          return fail(500, { message: stampErr.message });
        }
      }
    }

    return { ok: true, scheduledBgResolve: work.length > 0 };
  },
};

// Cover-upload action body extracted so the dimension-validation and
// upload/rollback orchestration can stay readable. Returns the same
// shape the action returns (fail() result or {ok:true}). Inferred
// return type intentional — SvelteKit's ActionData union loses the
// fail() data shape when fed an explicit ReturnType<typeof fail>.
async function uploadCoverAction(
  userId: string,
  catalogId: string,
  file: File,
) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dims = decodeImageDimensions(bytes);
  if (!dims) return fail(400, { message: "could not decode image" });
  // Bound dimensions before persisting — JPEG SOF can claim 65535 px in
  // either axis (decompression-bomb header), and `cover_max_width` is
  // Postgres INT (4 bytes). Practical operator-uploaded covers fall well
  // inside 200..4000 × 300..6000. Below the resolver's salvage tier
  // (240 px) rejects too — match that floor.
  if (
    dims.width < 240 ||
    dims.width > 4000 ||
    dims.height < 300 ||
    dims.height > 6000
  ) {
    return fail(400, {
      message: `image dimensions ${dims.width}×${dims.height} out of accept range (240..4000 × 300..6000)`,
    });
  }
  // Derive storage Content-Type from the magic-byte decoder output
  // rather than the client-supplied `file.type` — the FormData mime is
  // operator-trusted in the admin frame but defense-in-depth is cheap.
  // The COVER_MIMES whitelist on `file.type` is kept above so a
  // mismatched file/extension at least fails before we touch bytes.
  const decodedMime =
    dims.type === "jpeg"
      ? "image/jpeg"
      : dims.type === "png"
        ? "image/png"
        : "image/webp";

  const upload = await uploadCover(bytes, decodedMime, {});
  const admin = createAdminClient();
  const { error: rpcErr } = await admin.rpc("admin_apply_action", {
    p_admin_user_id: userId,
    p_catalog_id: catalogId,
    p_action: "upload_cover",
    p_patch_jsonb: {
      storage_path: upload.storage_path,
      cover_storage_backend: upload.backend,
      image_sha256: upload.image_sha256,
      cover_max_width: dims.width,
    },
  });
  if (rpcErr) {
    // Roll back the storage write so an RPC failure (concurrent edit,
    // permission glitch, etc.) does not leave an orphaned object behind.
    // Sha-keyed Supabase / Cloudflare objects dedup on retry, so the
    // common-case (operator clicks Upload again) does not re-orphan.
    await rollbackCoverUpload(upload.storage_path, upload.backend);
    return fail(500, { message: rpcErr.message });
  }
  return { ok: true };
}

async function rollbackCoverUpload(
  storagePath: string,
  backend: "supabase" | "cloudflare-images",
): Promise<void> {
  try {
    if (backend === "supabase") {
      const admin = createAdminClient();
      await admin.storage.from("cover-cache").remove([storagePath]);
    } else {
      // Cloudflare Images DELETE — handled in cover-storage.ts via
      // deleteCloudflareImage(). Imported lazily so a Supabase-backend
      // dev server doesn't pull in the CF code path on every load.
      const { deleteCloudflareImage } =
        await import("$lib/server/cover-storage");
      await deleteCloudflareImage(storagePath);
    }
  } catch {
    // Rollback is best-effort; the synchronous RPC failure is the
    // operator-facing signal. Don't crash the action handler on a
    // secondary cleanup error.
  }
}
