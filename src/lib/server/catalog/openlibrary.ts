import type {
  OpenLibraryDataDoc,
  OpenLibraryWork,
  OpenLibrarySearchDoc,
  OpenLibraryEditionsResponse,
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

/**
 * Multi-result title+author search for the work-resolver ranker. Distinct
 * from `searchOpenLibraryByTitleAuthor` (limit=1, single doc) which serves
 * `discoverOpenLibraryCoverId` on the ISBN path — do NOT merge them. Requests
 * the ranking signals (edition_count, first_publish_year) the ranker needs.
 */
export async function searchOpenLibraryWorksByTitleAuthor(
  title: string,
  author: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibrarySearchDoc[]> {
  const url =
    `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}` +
    `&author=${encodeURIComponent(author)}` +
    `&fields=cover_i,title,author_name,key,edition_count,first_publish_year&limit=10`;
  const body = await fetchCatalogJson<{ docs?: OpenLibrarySearchDoc[] }>(
    url,
    deps,
    "openlibrary",
  );
  return body?.docs ?? [];
}

/**
 * Fetch a work's editions list (cover IDs only consumed downstream). Capped
 * at limit=20 — most works have <=10 editions; long-tail bounded. Returns null
 * on 404 (fetchCatalogJson contract); the walker treats null as "no editions".
 */
export async function fetchOpenLibraryEditions(
  workId: string,
  deps: OpenLibraryDeps = {},
): Promise<OpenLibraryEditionsResponse | null> {
  return fetchCatalogJson<OpenLibraryEditionsResponse>(
    `https://openlibrary.org/works/${workId}/editions.json?limit=20`,
    deps,
    "openlibrary",
  );
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
  deps: OpenLibraryDeps & { minWidth?: number } = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  // default=false: OL returns 404 instead of falling back to -M when -L is
  // unavailable. Without this, OL silently serves the smaller size and our
  // byte-size floor lets it through (issue #199).
  return downloadCover(
    `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`,
    {
      fetchFn: deps.fetchFn,
      minBytes: COVER_MIN_BYTES,
      maxBytes: COVER_MAX_BYTES,
      minWidth: deps.minWidth,
      source: "openlibrary",
      allowedHosts: ["covers.openlibrary.org"],
    },
  );
}

/**
 * Direct-ISBN cover lookup against OpenLibrary's cover CDN. Distinct from
 * `fetchOpenLibraryCoverBytes(coverId)` because OL's CDN resolves the ISBN
 * endpoint against ANY edition of the underlying Work that has cover
 * bytes — not just the queried edition's `cover.large_id`. Substitutes
 * for explicit `/works/{id}/editions.json` iteration with one HTTP call.
 *
 * `?default=false` makes OL return 404 instead of silently downgrading
 * to a smaller size when -L is unavailable. Same posture as
 * `fetchOpenLibraryCoverBytes`.
 *
 * Returns null on any non-2xx, undersized bytes, or dimension floor miss.
 * Caller (resolver chain) treats null as "no cover from this tier" and
 * falls through.
 */
export async function fetchOpenLibraryCoverBytesByIsbn(
  isbn: string,
  deps: OpenLibraryDeps & { minWidth?: number } = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  return downloadCover(
    `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
    {
      fetchFn: deps.fetchFn,
      minBytes: COVER_MIN_BYTES,
      maxBytes: COVER_MAX_BYTES,
      minWidth: deps.minWidth,
      source: "openlibrary",
      allowedHosts: ["covers.openlibrary.org"],
    },
  );
}
