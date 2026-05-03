import { canonicalizeIsbn } from "./isbn";

/**
 * Parse the optional `{ isbns: [...] }` body for the catalog-warmup cron.
 *
 * Returns the canonicalized list when the body is valid JSON with an `isbns`
 * array of strings (empty array included — caller treats [] as truthy and
 * picks "body" source). Returns null on invalid JSON, missing key, or
 * non-array value. Caller falls through to the default NYT bestseller source
 * on null.
 */
export async function parseIsbnsFromBody(
  request: Request,
): Promise<string[] | null> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return null;
  }
  try {
    const body = (await request.json()) as { isbns?: unknown };
    if (!Array.isArray(body.isbns)) return null;
    return body.isbns
      .map((s) => (typeof s === "string" ? canonicalizeIsbn(s) : null))
      .filter((s): s is string => !!s);
  } catch {
    // Body parse failure — fall through to NYT default.
    return null;
  }
}
