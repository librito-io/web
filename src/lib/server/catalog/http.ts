// Shared HTTP helpers for catalog provider modules (openlibrary.ts, googlebooks.ts).
// Provider-specific concerns (URL construction, response shape parsing, byte thresholds)
// stay in their respective modules; shared plumbing lives here.

const LIBRITO_UA = "librito-catalog/1.0 (+https://librito.io)";

// PR 4 audit #8: SSRF whitelist parameter (allowedHosts) lands here.

export interface FetchCatalogJsonDeps {
  fetchFn?: typeof fetch;
}

/**
 * Fetch a URL and return the parsed JSON body, or null on 404.
 * Throws for any other non-2xx status, with `source` prefixed in the message
 * so log greps can distinguish openlibrary vs googlebooks errors.
 */
export async function fetchCatalogJson<T>(
  url: string,
  deps: FetchCatalogJsonDeps,
  source: string,
): Promise<T | null> {
  const f = deps.fetchFn ?? fetch;
  const res = await f(url, {
    headers: { "user-agent": LIBRITO_UA, accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${source} ${res.status} ${url}`);
  return (await res.json()) as T;
}

export interface DownloadCoverOptions {
  fetchFn?: typeof fetch;
  minBytes: number;
  maxBytes: number;
  source: string;
}

/**
 * Download a cover image, enforcing size bounds.
 *
 * Two-layer size guard (PR 2 fix #9):
 *   1. Content-Length pre-check — rejects without buffering when upstream
 *      advertises an oversize payload.
 *   2. Post-arrayBuffer backstop — catches chunked encoding / missing-CL
 *      responses (lh3.googleusercontent.com observed omitting Content-Length).
 *
 * Both layers must remain; the refactor restructures only.
 */
export async function downloadCover(
  url: string,
  opts: DownloadCoverOptions,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const f = opts.fetchFn ?? fetch;
  const res = await f(url, { headers: { "user-agent": LIBRITO_UA } });
  if (!res.ok) return null;
  // Layer 1: Content-Length pre-check (no buffering on oversize).
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > opts.maxBytes) return null;
  // Layer 2: Post-buffer backstop.
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < opts.minBytes) return null;
  if (buf.byteLength > opts.maxBytes) return null;
  return { bytes: buf, mime: res.headers.get("content-type") ?? "image/jpeg" };
}
