import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveIsbn, resolveTitleAuthor } from "./fetcher";
import type { ResolveDeps } from "./fetcher";
import type { CatalogResolveWork } from "./scheduling";

/**
 * Per-item dispatch shared by the inline producer branch
 * (`scheduling.ts`) and the QStash consumer route
 * (`/api/queue/catalog-resolve`). One definition guarantees both paths
 * produce identical resolver behavior.
 *
 * `userId` is logged for attribution upstream; not read inside the
 * resolver.
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
