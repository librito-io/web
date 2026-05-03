import { canonicalizeIsbn } from "./isbn";

export async function fetchNytBestsellerIsbns(
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<string[]> {
  if (!apiKey) return [];
  const lists = [
    "hardcover-fiction",
    "hardcover-nonfiction",
    "trade-fiction-paperback",
  ];
  const isbns = new Set<string>();
  for (const list of lists) {
    try {
      const res = await fetchFn(
        `https://api.nytimes.com/svc/books/v3/lists/current/${list}.json?api-key=${encodeURIComponent(apiKey)}`,
      );
      if (!res.ok) continue;
      const body = (await res.json()) as {
        results?: { books?: { primary_isbn13?: string }[] };
      };
      for (const b of body.results?.books ?? []) {
        const c = canonicalizeIsbn(b.primary_isbn13);
        if (c) isbns.add(c);
      }
    } catch (err) {
      console.warn("catalog_warmup_nyt_failed", { list, error: String(err) });
    }
  }
  return [...isbns];
}
