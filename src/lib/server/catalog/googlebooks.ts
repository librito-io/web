import type { GoogleBooksItem } from "./types";

export interface GoogleBooksDeps {
  fetchFn?: typeof fetch;
  apiKey?: string;
}

const UA = "librito-catalog/1.0 (+https://librito.io)";

async function fetchJson<T>(url: string, deps: GoogleBooksDeps): Promise<T> {
  const f = deps.fetchFn ?? fetch;
  const res = await f(url, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`googlebooks ${res.status} ${url}`);
  return (await res.json()) as T;
}

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
  const body = await fetchJson<{ items?: GoogleBooksItem[] }>(url, deps);
  return body.items?.[0] ?? null;
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
  const body = await fetchJson<{ items?: GoogleBooksItem[] }>(url, deps);
  return body.items?.[0] ?? null;
}

const COVER_MIN_BYTES = 512;

export async function fetchGoogleBooksCoverBytes(
  rawUrl: string,
  deps: GoogleBooksDeps = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const f = deps.fetchFn ?? fetch;
  const url = rawUrl.replace(/^http:/, "https:");
  const res = await f(url, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < COVER_MIN_BYTES) return null;
  return { bytes: buf, mime: res.headers.get("content-type") ?? "image/jpeg" };
}
