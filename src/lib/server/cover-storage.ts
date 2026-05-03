import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "$lib/server/supabase";
import { PUBLIC_SUPABASE_URL } from "$env/static/public";
import { COVER_STORAGE_BACKEND } from "$env/static/private";
import { env as privateEnv } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import type { CoverStorageBackend, CoverVariant } from "./catalog/types";

// Supabase backend serves the full-size object at every variant (no
// runtime resize — Image Transformation is Pro-tier only and self-hosters
// run on Free tier). The browser sizes via HTML width/height + CSS.
// Cloudflare Images backend uses named variants for true edge resize.
export const COVER_BUCKET = "cover-cache";

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
  return (COVER_STORAGE_BACKEND as CoverStorageBackend) === "cloudflare-images"
    ? "cloudflare-images"
    : "supabase";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
): string {
  if (backend === "cloudflare-images") {
    const hash = publicEnv.PUBLIC_CLOUDFLARE_IMAGES_HASH;
    if (!hash) {
      throw new Error(
        "Cloudflare Images backend requires PUBLIC_CLOUDFLARE_IMAGES_HASH env var.",
      );
    }
    return `https://imagedelivery.net/${hash}/${storagePath}/${variant}`;
  }
  // Supabase backend: variant is a layout hint; the URL itself is the
  // full-size public object. Caller is responsible for sizing via
  // HTML width/height + CSS.
  void variant;
  return `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/${COVER_BUCKET}/${storagePath}`;
}
