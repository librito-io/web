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

export async function fetchGoogleBooksCoverBytes(
  rawUrl: string,
  deps: GoogleBooksDeps = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  return downloadCover(rawUrl.replace(/^http:/, "https:"), {
    fetchFn: deps.fetchFn,
    minBytes: COVER_MIN_BYTES,
    maxBytes: COVER_MAX_BYTES,
    source: "googlebooks",
  });
}
