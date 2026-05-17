import { fetchCatalogJson, downloadCover } from "./http";

export interface ItunesDeps {
  fetchFn?: typeof fetch;
}

export interface ItunesResult {
  artistName?: string;
  trackName?: string;
  artworkUrl60?: string;
  artworkUrl100?: string;
  wrapperType?: string;
}

const COVER_MIN_BYTES = 1024;
const COVER_MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_HOSTS = [
  "is1-ssl.mzstatic.com",
  "is2-ssl.mzstatic.com",
  "is3-ssl.mzstatic.com",
  "is4-ssl.mzstatic.com",
  "is5-ssl.mzstatic.com",
  "is6-ssl.mzstatic.com",
  "is7-ssl.mzstatic.com",
  "is8-ssl.mzstatic.com",
  "is9-ssl.mzstatic.com",
] as const;

// Replace any {N}x{N}bb.{ext} size token in an mzstatic URL with
// 2400x2400bb.{ext}. The {N}x{N}bb URL pattern is undocumented but stable
// for ~10 years across iTunes/App Store/Apple Books. 2400 yields ~1500-1600px
// wide on book covers (Phase 0 sample, 2026-05-17), clearing the 1200px
// premium-tier floor with margin. 1400x1400bb yields only ~900px wide
// (insufficient); 1800x1800bb is borderline. 2400 is the sweet spot.
export function upgradeArtworkUrl(url: string): string {
  return url.replace(/\/\d+x\d+bb(\.[a-z]+)/i, "/2400x2400bb$1");
}

export async function fetchItunesByIsbn(
  isbn: string,
  deps: ItunesDeps = {},
): Promise<ItunesResult | null> {
  const url = `https://itunes.apple.com/lookup?isbn=${encodeURIComponent(isbn)}`;
  const body = await fetchCatalogJson<{
    resultCount?: number;
    results?: ItunesResult[];
  }>(url, deps, "itunes");
  if (!body || !body.results || body.results.length === 0) return null;
  return body.results[0];
}

export async function fetchItunesCoverBytes(
  artworkUrl: string,
  deps: ItunesDeps & { minWidth?: number } = {},
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  return downloadCover(upgradeArtworkUrl(artworkUrl), {
    fetchFn: deps.fetchFn,
    minBytes: COVER_MIN_BYTES,
    maxBytes: COVER_MAX_BYTES,
    minWidth: deps.minWidth,
    source: "itunes",
    allowedHosts: ALLOWED_HOSTS,
  });
}
