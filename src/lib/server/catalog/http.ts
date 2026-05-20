// Shared HTTP helpers for catalog provider modules (openlibrary.ts, googlebooks.ts).
// Provider-specific concerns (URL construction, response shape parsing, byte thresholds)
// stay in their respective modules; shared plumbing lives here.

import { decodeImageDimensions } from "./dimensions";

const LIBRITO_UA = "librito-catalog/1.0 (+https://librito.io)";

// Query params that may carry secret material across catalog upstreams.
// Currently triggered by GoogleBooks' `&key=<API_KEY>` (added by
// withKey() in googlebooks.ts) — a non-200 from GB would otherwise embed
// the plaintext API key in the thrown Error.message, and sentry-scrub
// intentionally does NOT pattern-scrub `event.message`. Sanitize here
// instead of relying on the implicit `memoize...catch{}` swallow in
// fetcher.ts. Future upstreams with bearer tokens / access_tokens get the
// same defense for free.
const SECRET_QUERY_PARAMS = ["key", "api_key", "access_token", "token"];

export function redactSecretParams(url: string): string {
  try {
    const u = new URL(url);
    for (const p of SECRET_QUERY_PARAMS) {
      if (u.searchParams.has(p)) u.searchParams.set(p, "[REDACTED]");
    }
    return u.toString();
  } catch {
    return "(unparseable url)";
  }
}

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
  if (!res.ok)
    throw new Error(`${source} ${res.status} ${redactSecretParams(url)}`);
  return (await res.json()) as T;
}

export interface DownloadCoverOptions {
  fetchFn?: typeof fetch;
  minBytes: number;
  maxBytes: number;
  /** Reject (return null) if the decoded image width is below this threshold.
   * Falsy = no floor. Composed with the byte-size guard; both must pass. */
  minWidth?: number;
  source: string;
  // SSRF guard: only hosts in this list (lowercase) are allowed.
  // Checked before fetch so a spoofed/MitM upstream URL never reaches the network.
  allowedHosts: readonly string[];
}

/**
 * Download a cover image, enforcing size bounds and an SSRF host whitelist.
 *
 * Returns null (never throws) on host rejection or malformed URL so the
 * resolver's per-source try/catch posture is preserved — same as non-ok
 * response, oversize, or undersize returns below.
 *
 * Three-layer guard (PR 2 fix #9; dimension floor added Task 2):
 *   1. Content-Length pre-check — rejects without buffering when upstream
 *      advertises an oversize payload.
 *   2. Post-arrayBuffer backstop — catches chunked encoding / missing-CL
 *      responses (lh3.googleusercontent.com observed omitting Content-Length).
 *   3. Dimension floor — rejects if decoded image width < opts.minWidth.
 *
 * Layers 1 and 2 must remain; the refactor restructures only.
 */
export async function downloadCover(
  url: string,
  opts: DownloadCoverOptions,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  // SSRF guard: parse and whitelist-check the URL before any network call.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!opts.allowedHosts.includes(parsed.hostname.toLowerCase())) return null;

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
  if (opts.minWidth) {
    const dims = decodeImageDimensions(buf);
    if (!dims || dims.width < opts.minWidth) return null;
  }
  return { bytes: buf, mime: res.headers.get("content-type") ?? "image/jpeg" };
}
