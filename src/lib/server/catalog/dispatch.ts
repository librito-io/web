import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveIsbn, resolveTitleAuthor } from "./fetcher";
import type { ResolveDeps } from "./fetcher";
import type { CatalogResolveWork } from "./scheduling";
import { TRACKED_FIELDS } from "$lib/catalog/tracked-fields";
import type { TrackedField } from "$lib/catalog/tracked-fields";
import {
  catalogOpenLibraryLimiter,
  catalogGoogleBooksLimiter,
  catalogITunesLimiter,
} from "$lib/server/ratelimit";

/**
 * Shared rate-limiter bundle. Hoisted here so adding a fourth source
 * lands in one place instead of two (scheduling.ts inline fallback +
 * consumer route deps object).
 */
export const catalogRateLimiters = {
  openLibrary: catalogOpenLibraryLimiter,
  googleBooks: catalogGoogleBooksLimiter,
  itunes: catalogITunesLimiter,
};

/**
 * Per-item dispatch shared by the inline producer branch
 * (`scheduling.ts`) and the QStash consumer route
 * (`/api/queue/catalog-resolve`). One definition guarantees both paths
 * produce identical resolver behavior.
 *
 * `_userId` is reserved for future use (provenance threading into
 * resolver-side logging); not currently read here or by callers. Kept
 * in the signature so adding it later is a no-op for call sites.
 */
export async function dispatchResolve(
  admin: SupabaseClient,
  deps: ResolveDeps,
  _userId: string,
  item: CatalogResolveWork,
): Promise<void> {
  if (item.kind === "isbn") {
    await resolveIsbn(admin, item.isbn, deps, item.ctx, item.fields);
  } else {
    await resolveTitleAuthor(admin, item.title, item.author, deps, item.fields);
  }
}

// ---------------------------------------------------------------------------
// Queue consumer payload parser
// ---------------------------------------------------------------------------

const TRACKED_FIELD_SET = new Set<string>(TRACKED_FIELDS);

export type ParsedPayload =
  | { ok: true; value: { userId: string; item: CatalogResolveWork } }
  | { ok: false; error: string };

// `[].every(...)` returns true; an empty `fields` array parses as ok with
// the resolver receiving `fields: []` (functionally equivalent to undefined
// today because `_fields` is intentionally unused per issue #439). Keep
// the vacuous accept rather than special-casing — producer never sends [].
function isFieldsArray(x: unknown): x is TrackedField[] {
  if (!Array.isArray(x)) return false;
  return x.every((f) => typeof f === "string" && TRACKED_FIELD_SET.has(f));
}

type ParseFieldsResult =
  | { ok: true; value: TrackedField[] | undefined }
  | { ok: false; error: string };

function parseFields(raw: unknown): ParseFieldsResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isFieldsArray(raw)) {
    return { ok: false, error: "fields contains unknown tracked field" };
  }
  return { ok: true, value: raw };
}

/**
 * Strict validator for the QStash `{ userId, item }` message body.
 *
 * Returns `{ ok: false }` on any malformed input so the consumer can
 * return 4xx → QStash treats that as a permanent failure and routes to
 * DLQ rather than retrying indefinitely.
 */
export function parseWorkPayload(body: string): ParsedPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, error: "body is not JSON" };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "body not object" };
  }
  const obj = raw as Record<string, unknown>;

  const userId = obj.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    return { ok: false, error: "userId missing or not string" };
  }

  const item = obj.item;
  if (!item || typeof item !== "object") {
    return { ok: false, error: "item missing or not object" };
  }
  const it = item as Record<string, unknown>;

  if (it.kind === "isbn") {
    if (typeof it.isbn !== "string" || it.isbn.trim().length === 0) {
      return { ok: false, error: "isbn missing" };
    }
    let parsedCtx: { title?: string; author?: string } | undefined;
    if (it.ctx !== undefined) {
      if (!it.ctx || typeof it.ctx !== "object") {
        return { ok: false, error: "ctx not object" };
      }
      const c = it.ctx as Record<string, unknown>;
      parsedCtx = {
        ...(typeof c.title === "string" ? { title: c.title } : {}),
        ...(typeof c.author === "string" ? { author: c.author } : {}),
      };
    }
    const fieldsResult = parseFields(it.fields);
    if (!fieldsResult.ok) return { ok: false, error: fieldsResult.error };
    const fields = fieldsResult.value;
    return {
      ok: true,
      value: {
        userId,
        item: { kind: "isbn", isbn: it.isbn, ctx: parsedCtx, fields },
      },
    };
  }

  if (it.kind === "ta") {
    if (typeof it.title !== "string" || it.title.trim().length === 0) {
      return { ok: false, error: "title missing" };
    }
    if (typeof it.author !== "string" || it.author.trim().length === 0) {
      return { ok: false, error: "author missing" };
    }
    const fieldsResult = parseFields(it.fields);
    if (!fieldsResult.ok) return { ok: false, error: fieldsResult.error };
    const fields = fieldsResult.value;
    return {
      ok: true,
      value: {
        userId,
        item: { kind: "ta", title: it.title, author: it.author, fields },
      },
    };
  }

  return { ok: false, error: "item.kind must be isbn or ta" };
}
