import type {
  OpenLibraryDataDoc,
  OpenLibraryWork,
  OpenLibrarySearchDoc,
} from "./types";
import { fetchCatalogJson, downloadCover } from "./http";

export interface OpenLibraryDeps {
  fetchFn?: typeof fetch;
}

const COVER_MIN_BYTES = 1024;
const COVER_MAX_BYTES = 5 * 1024 * 1024;

export async function fetchOpenLibraryByIsbn(
  isbn: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibraryDataDoc | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  const body = await fetchCatalogJson<Record<string, OpenLibraryDataDoc>>(
    url,
    deps,
    "openlibrary",
  );
  return body?.[`ISBN:${isbn}`] ?? null;
}

export async function searchOpenLibraryByIsbn(
  isbn: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibrarySearchDoc | null> {
  const url =
    `https://openlibrary.org/search.json?q=isbn:${isbn}` +
    `&fields=cover_i,title,author_name,key&limit=1`;
  const body = await fetchCatalogJson<{ docs?: OpenLibrarySearchDoc[] }>(
    url,
    deps,
    "openlibrary",
  );
  return body?.docs?.[0] ?? null;
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
  const body = await fetchCatalogJson<{ docs?: OpenLibrarySearchDoc[] }>(
    url,
    deps,
    "openlibrary",
  );
  return body?.docs?.[0] ?? null;
}

export async function fetchOpenLibraryWork(
  workId: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibraryWork> {
  const body = await fetchCatalogJson<OpenLibraryWork>(
    `https://openlibrary.org/works/${workId}.json`,
    deps,
    "openlibrary",
  );
  // OL works endpoint returns 200 with content; null only on 404.
  if (body === null) throw new Error(`openlibrary 404 /works/${workId}.json`);
  return body;
}

export async function fetchOpenLibraryCoverBytes(
  coverId: number,
  deps: OpenLibraryDeps = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  return downloadCover(`https://covers.openlibrary.org/b/id/${coverId}-L.jpg`, {
    fetchFn: deps.fetchFn,
    minBytes: COVER_MIN_BYTES,
    maxBytes: COVER_MAX_BYTES,
    source: "openlibrary",
  });
}
