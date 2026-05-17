import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "$lib/server/supabase";
import { PUBLIC_SUPABASE_URL } from "$env/static/public";
// COVER_STORAGE_BACKEND is Sensitive in Vercel — static import bakes empty
// into prebuilt deploys (vercel pull redacts sensitive vars), causing
// silent fallback to the `supabase` default in production. Read at runtime.
import { env as privateEnv } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import type { CoverStorageBackend, CoverVariant } from "./catalog/types";
import { sha256Hex } from "./catalog/sha";

// Supabase backend serves the full-size object at every variant (no
// runtime resize — Image Transformation is Pro-tier only and self-hosters
// run on Free tier). The browser sizes via HTML width/height + CSS.
// Cloudflare Images backend uses named variants for true edge resize.
export const COVER_BUCKET = "cover-cache";

/** Minimum source width (px) that lets a variant render natively at its
 * configured dimensions. Must stay in sync with the Cloudflare Images dashboard
 * variant config; if dashboard config changes, update this table.
 * See docs/superpowers/plans/2026-05-17-catalog-cover-resolution.md Phase 2. */
const VARIANT_MIN_SOURCE_WIDTH: Record<CoverVariant, number> = {
  thumbnail: 240,
  medium: 300,
  large: 600,
  xlarge: 1200,
};

/** Variant order from largest to smallest, for fallback walking. */
const VARIANTS_BY_SIZE: CoverVariant[] = [
  "xlarge",
  "large",
  "medium",
  "thumbnail",
];

/** Given a requested variant and the source's max width (or null when unknown,
 * which we treat as "trust the request"), return the largest variant that
 * renders natively from the source. Never upscales beyond source.
 *
 * Examples:
 *   resolveVariant("xlarge", null) → "xlarge" (trust caller)
 *   resolveVariant("xlarge", 1500) → "xlarge" (native fit)
 *   resolveVariant("xlarge",  800) → "large"  (downgrade to fit)
 *   resolveVariant("large",   500) → "medium" (downgrade)
 *   resolveVariant("thumbnail", 5000) → "thumbnail" (don't upgrade) */
export function resolveVariant(
  requested: CoverVariant,
  coverMaxWidth: number | null,
): CoverVariant {
  if (coverMaxWidth === null) return requested;
  const reqIdx = VARIANTS_BY_SIZE.indexOf(requested);
  for (let i = reqIdx; i < VARIANTS_BY_SIZE.length; i++) {
    const v = VARIANTS_BY_SIZE[i];
    if (coverMaxWidth >= VARIANT_MIN_SOURCE_WIDTH[v]) return v;
  }
  return "thumbnail"; // last resort — source below all floors
}

export interface UploadDeps {
  supabase?: SupabaseClient;
  fetchFn?: typeof fetch;
}

export interface UploadResult {
  storage_path: string;
  backend: CoverStorageBackend;
  image_sha256: string;
}

function activeBackend(): CoverStorageBackend {
  return privateEnv.COVER_STORAGE_BACKEND === "cloudflare-images"
    ? "cloudflare-images"
    : "supabase";
}

function extFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

async function uploadSupabase(
  bytes: Uint8Array,
  mime: string,
  sha: string,
  deps: UploadDeps,
): Promise<UploadResult> {
  const sb = deps.supabase ?? createAdminClient();
  const path = `${sha.slice(0, 2)}/${sha.slice(2)}.${extFromMime(mime)}`;
  const { error } = await sb.storage.from(COVER_BUCKET).upload(path, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (error && !/already exists/i.test(error.message ?? "")) {
    throw new Error(`cover-storage supabase upload: ${error.message}`);
  }
  return { storage_path: path, backend: "supabase", image_sha256: sha };
}

async function uploadCloudflare(
  bytes: Uint8Array,
  mime: string,
  sha: string,
  deps: UploadDeps,
): Promise<UploadResult> {
  const accountId = privateEnv.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = privateEnv.CLOUDFLARE_IMAGES_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "Cloudflare Images backend requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_IMAGES_API_TOKEN env vars. " +
        "Set COVER_STORAGE_BACKEND=supabase to use Supabase Storage instead.",
    );
  }
  const f = deps.fetchFn ?? fetch;
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
    `${sha}.${extFromMime(mime)}`,
  );
  form.append("id", sha);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`;
  const res = await f(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}` },
    body: form,
  });
  if (!res.ok) {
    if (res.status === 409) {
      // Already uploaded by sha — id is the same.
      return {
        storage_path: sha,
        backend: "cloudflare-images",
        image_sha256: sha,
      };
    }
    throw new Error(`cover-storage cloudflare upload: ${res.status}`);
  }
  const body = (await res.json()) as { result?: { id?: string } };
  const id = body.result?.id ?? sha;
  return { storage_path: id, backend: "cloudflare-images", image_sha256: sha };
}

export async function uploadCover(
  bytes: Uint8Array,
  mime: string,
  deps: UploadDeps = {},
): Promise<UploadResult> {
  const sha = await sha256Hex(bytes);
  return activeBackend() === "cloudflare-images"
    ? uploadCloudflare(bytes, mime, sha, deps)
    : uploadSupabase(bytes, mime, sha, deps);
}

export function coverUrl(
  storagePath: string,
  backend: CoverStorageBackend,
  variant: CoverVariant,
  coverMaxWidth: number | null = null,
): string {
  const effectiveVariant = resolveVariant(variant, coverMaxWidth);
  if (backend === "cloudflare-images") {
    const hash = publicEnv.PUBLIC_CLOUDFLARE_IMAGES_HASH;
    if (!hash) {
      throw new Error(
        "Cloudflare Images backend requires PUBLIC_CLOUDFLARE_IMAGES_HASH env var.",
      );
    }
    return `https://imagedelivery.net/${hash}/${storagePath}/${effectiveVariant}`;
  }
  // Supabase backend: variant is a layout hint; the URL itself is the
  // full-size public object. Caller is responsible for sizing via
  // HTML width/height + CSS.
  void effectiveVariant;
  return `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/${COVER_BUCKET}/${storagePath}`;
}
