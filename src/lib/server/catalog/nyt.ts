import { canonicalizeIsbn } from "./isbn";

const NYT_LISTS = [
  "hardcover-fiction",
  "hardcover-nonfiction",
  "trade-fiction-paperback",
];

const NYT_FETCH_TIMEOUT_MS = 5000;

export async function fetchNytBestsellerIsbns(
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<string[]> {
  if (!apiKey) return [];

  const perList = await Promise.all(
    NYT_LISTS.map(async (list) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NYT_FETCH_TIMEOUT_MS);
      try {
        const res = await fetchFn(
          `https://api.nytimes.com/svc/books/v3/lists/current/${list}.json?api-key=${encodeURIComponent(apiKey)}`,
          { signal: controller.signal },
        );
        if (!res.ok) return [] as string[];
        const body = (await res.json()) as {
          results?: { books?: { primary_isbn13?: string }[] };
        };
        const found: string[] = [];
        for (const b of body.results?.books ?? []) {
          const c = canonicalizeIsbn(b.primary_isbn13);
          if (c) found.push(c);
        }
        return found;
      } catch (err) {
        console.warn("catalog_warmup_nyt_failed", { list, error: String(err) });
        return [] as string[];
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const isbns = new Set<string>();
  for (const list of perList) {
    for (const isbn of list) isbns.add(isbn);
  }
  return [...isbns];
}
