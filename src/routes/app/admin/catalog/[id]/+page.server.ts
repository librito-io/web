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
import { normalizeTitleAuthor } from "$lib/server/catalog/title-author";
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
// Loser catalog ids for the mergeDuplicates action are validated at the
// boundary so a malformed value can't reach the RPC's uuid[] param.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  // Auto-suggest drift-dup candidates (#489 Fix C): other ISBN-less rows
  // whose OWN canonical normalizeTitleAuthor(title, author) equals this
  // row's canonical key but are stored under a different key. This catches
  // the pure drift case exactly. Spelling dups ("1984" vs "Nineteen
  // Eighty-Four") normalize differently and are NOT surfaced here — the
  // operator merges those by pasting loser ids (only a human can judge two
  // differently-spelled titles are one book).
  //
  // Bounded scan (200) over ISBN-less rows. book_catalog is shared
  // per-ISBN/per-(title,author) data deduplicated across all users, so it
  // stays modest (hundreds, not per-user millions) at the 1k-user target;
  // revisit with an indexed approach if the TA partition ever grows large.
  let mergeCandidates: Array<{
    id: string;
    title: string | null;
    author: string | null;
    normalized_title_author: string | null;
    storage_path: string | null;
    cover_max_width: number | null;
    cover_source: string | null;
  }> = [];
  if (!row.isbn && row.title && row.author) {
    const canonical = normalizeTitleAuthor(row.title, row.author);
    if (canonical) {
      const { data: taRows } = await admin
        .from("book_catalog")
        .select(
          "id, title, author, normalized_title_author, storage_path, cover_max_width, cover_source",
        )
        .is("isbn", null)
        .neq("id", row.id)
        .limit(200);
      mergeCandidates = (taRows ?? []).filter(
        (r) => normalizeTitleAuthor(r.title, r.author) === canonical,
      );
    }
  }

  return { row, dlqArchive, mergeCandidates };
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
      // Pass the row's STORED key so the re-resolve targets THIS row by its
      // current key, even if its title/author have drifted away from what
      // the key was derived from (issue #489 Fix A). Without it the resolver
      // re-derives a key from the drifted title and forks a duplicate row.
      work = [
        {
          kind: "ta",
          title: row.title,
          author: row.author,
          fields,
          ...(row.normalized_title_author
            ? { normalizedTitleAuthor: row.normalized_title_author }
            : {}),
        },
      ];
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

  // Collapse one or more duplicate TA rows (same book, different keys) into
  // the row being viewed (the survivor). The operator chooses which rows are
  // duplicates and which survives — no heuristic can reliably tell a spelling
  // dup ("1984" vs "Nineteen Eighty-Four") is one book (issue #489 Fix C).
  // The merge_ta_catalog_dups RPC deletes the losers wholesale, preserving
  // audit history attached to the survivor.
  mergeDuplicates: async (event) => {
    const user = await requireAdmin(event);
    const id = requireUuidParam(event.params.id);
    const fd = await event.request.formData();
    // Two input sources: auto-suggest checkboxes (loser_id) + a free-text
    // field (loser_id_manual, whitespace/newline-separated) for spelling
    // dups the auto-detector can't surface. Union + dedup.
    const fromCheckboxes = fd.getAll("loser_id").map((v) => String(v));
    const fromManual = String(fd.get("loser_id_manual") ?? "").split(/\s+/);
    const loserIds = [
      ...new Set(
        [...fromCheckboxes, ...fromManual]
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      ),
    ];
    if (loserIds.length === 0) {
      return fail(400, {
        message: "select at least one duplicate row to merge",
      });
    }
    const bad = loserIds.find((v) => !UUID_RE.test(v));
    if (bad) {
      return fail(400, { message: `invalid catalog id: ${bad}` });
    }
    if (loserIds.includes(id)) {
      return fail(400, { message: "cannot merge a row into itself" });
    }
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("merge_ta_catalog_dups", {
      p_admin_user_id: user.id,
      p_survivor_id: id,
      p_loser_ids: loserIds,
    });
    if (rpcErr) return fail(500, { message: rpcErr.message });
    return { ok: true };
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
