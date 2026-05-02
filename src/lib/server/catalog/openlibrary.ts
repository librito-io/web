import type {
  OpenLibraryDataDoc,
  OpenLibraryWork,
  OpenLibrarySearchDoc,
} from "./types";

export interface OpenLibraryDeps {
  fetchFn?: typeof fetch;
}

const UA = "librito-catalog/1.0 (+https://librito.io)";
const BASE_HEADERS = { "user-agent": UA, accept: "application/json" } as const;

async function fetchJson<T>(url: string, deps: OpenLibraryDeps): Promise<T> {
  const f = deps.fetchFn ?? fetch;
  const res = await f(url, { headers: BASE_HEADERS });
  if (!res.ok) throw new Error(`openlibrary ${res.status} ${url}`);
  return (await res.json()) as T;
}

export async function fetchOpenLibraryByIsbn(
  isbn: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibraryDataDoc | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  const body = await fetchJson<Record<string, OpenLibraryDataDoc>>(url, deps);
  return body[`ISBN:${isbn}`] ?? null;
}

export async function searchOpenLibraryByIsbn(
  isbn: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibrarySearchDoc | null> {
  const url =
    `https://openlibrary.org/search.json?q=isbn:${isbn}` +
    `&fields=cover_i,title,author_name,key&limit=1`;
  const body = await fetchJson<{ docs?: OpenLibrarySearchDoc[] }>(url, deps);
  return body.docs?.[0] ?? null;
}

export async function searchOpenLibraryByTitleAuthor(
  title: string,
  author: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibrarySearchDoc | null> {
  const url =
    `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}` +
    `&author=${encodeURIComponent(author)}` +
    `&fields=cover_i,title,author_name,key&limit=1`;
  const body = await fetchJson<{ docs?: OpenLibrarySearchDoc[] }>(url, deps);
  return body.docs?.[0] ?? null;
}

export async function fetchOpenLibraryWork(
  workId: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibraryWork> {
  return fetchJson<OpenLibraryWork>(
    `https://openlibrary.org/works/${workId}.json`,
    deps,
  );
}

const COVER_MIN_BYTES = 1024;

export async function fetchOpenLibraryCoverBytes(
  coverId: number,
  deps: OpenLibraryDeps = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const f = deps.fetchFn ?? fetch;
  const url = `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
  const res = await f(url, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < COVER_MIN_BYTES) return null;
  return { bytes: buf, mime: res.headers.get("content-type") ?? "image/jpeg" };
}
