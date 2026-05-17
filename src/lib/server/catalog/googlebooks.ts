import type { GoogleBooksItem } from "./types";
import { fetchCatalogJson, downloadCover } from "./http";

export interface GoogleBooksDeps {
  fetchFn?: typeof fetch;
  apiKey?: string;
}

const COVER_MIN_BYTES = 512;
const COVER_MAX_BYTES = 5 * 1024 * 1024;

function withKey(url: string, apiKey?: string): string {
  return apiKey ? `${url}&key=${encodeURIComponent(apiKey)}` : url;
}

export async function fetchGoogleBooksByIsbn(
  isbn: string,
  deps: GoogleBooksDeps = {},
): Promise<GoogleBooksItem | null> {
  const url = withKey(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`,
    deps.apiKey,
  );
  const body = await fetchCatalogJson<{ items?: GoogleBooksItem[] }>(
    url,
    deps,
    "googlebooks",
  );
  return body?.items?.[0] ?? null;
}

export async function fetchGoogleBooksByTitleAuthor(
  title: string,
  author: string,
  deps: GoogleBooksDeps = {},
): Promise<GoogleBooksItem | null> {
  const q = `intitle:${encodeURIComponent(title)}+inauthor:${encodeURIComponent(author)}`;
  const url = withKey(
    `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`,
    deps.apiKey,
  );
  const body = await fetchCatalogJson<{ items?: GoogleBooksItem[] }>(
    url,
    deps,
    "googlebooks",
  );
  return body?.items?.[0] ?? null;
}

/** Pick the highest-resolution imageLinks URL available. Order: extraLarge →
 * large → medium → small → thumbnail. Skips smallThumbnail (~80px wide; never
 * useful even as a last resort). Returns undefined when nothing usable. */
export function selectBestGoogleImageLink(
  links: NonNullable<GoogleBooksItem["volumeInfo"]["imageLinks"]>,
): string | undefined {
  return (
    links.extraLarge ??
    links.large ??
    links.medium ??
    links.small ??
    links.thumbnail
  );
}

/** Rewrite a GoogleBooks cover URL for max resolution.
 *  - zoom=1 → zoom=0 (or insert zoom=0 when absent); zoom=0 returns the
 *    underlying full-resolution scan while zoom=1 caps around 256px wide.
 *  - strip edge=curl (cosmetic page-curl effect, undesirable on stored covers).
 *  - force https. */
export function massageGoogleBooksCoverUrl(raw: string): string {
  let url = raw.replace(/^http:/, "https:").replace(/[?&]edge=curl/, "");
  if (/[?&]zoom=\d+/.test(url)) {
    url = url.replace(/([?&]zoom=)\d+/, "$10");
  } else {
    url += (url.includes("?") ? "&" : "?") + "zoom=0";
  }
  return url;
}

export async function fetchGoogleBooksCoverBytes(
  rawUrl: string,
  deps: GoogleBooksDeps & { minWidth?: number } = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  // Host check runs on the massaged URL for consistency.
  // books.google.com: primary cover CDN (fixture-confirmed).
  // lh3.googleusercontent.com: observed serving covers while omitting Content-Length.
  return downloadCover(massageGoogleBooksCoverUrl(rawUrl), {
    fetchFn: deps.fetchFn,
    minBytes: COVER_MIN_BYTES,
    maxBytes: COVER_MAX_BYTES,
    minWidth: deps.minWidth,
    source: "googlebooks",
    allowedHosts: ["books.google.com", "lh3.googleusercontent.com"],
  });
}
