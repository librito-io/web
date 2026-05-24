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

// Default per-call timeouts. Stalled upstream CDNs (mzstatic, lh3.googleusercontent,
// covers.openlibrary) would otherwise hold the Vercel function alive until the
// 300s function-level timeout; one stalled fetch occupies an instance + delays
// subsequent resolves under Fluid Compute (issue #251). JSON metadata is small
// and cap-friendly; cover bytes warrant a larger budget for slower image CDNs.
const DEFAULT_JSON_TIMEOUT_MS = 8000;
const DEFAULT_COVER_TIMEOUT_MS = 15000;

export interface FetchCatalogJsonDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
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
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? DEFAULT_JSON_TIMEOUT_MS,
  );
  try {
    const res = await f(url, {
      headers: { "user-agent": LIBRITO_UA, accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new Error(`${source} ${res.status} ${redactSecretParams(url)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface DownloadCoverOptions {
  fetchFn?: typeof fetch;
  minBytes: number;
  maxBytes: number;
  /** Reject (return null) if the decoded image width is below this threshold.
   * Falsy = no floor. Composed with the byte-size guard; both must pass. */
  minWidth?: number;
  /** Abort the fetch after this many ms. Defaults to 15s — binary downloads
   * tolerate more latency than JSON metadata. */
  timeoutMs?: number;
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
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_COVER_TIMEOUT_MS,
  );
  try {
    const res = await f(url, {
      headers: { "user-agent": LIBRITO_UA },
      signal: controller.signal,
    });
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
    return {
      bytes: buf,
      mime: res.headers.get("content-type") ?? "image/jpeg",
    };
  } finally {
    clearTimeout(timer);
  }
}
