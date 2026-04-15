import type { Sort } from "./types";

export const SORT_COOKIE = "librito_sort";

const VALID: ReadonlySet<Sort> = new Set([
  "recent",
  "title",
  "author",
  "reading",
]);

export function parseSort(
  value: string | null | undefined,
  fallback: Sort,
): Sort {
  if (!value) return fallback;
  return VALID.has(value as Sort) ? (value as Sort) : fallback;
}

export type SortOption = {
  value: Sort;
  labelKey: string;
};

export const FEED_SORT_OPTIONS: readonly SortOption[] = [
  { value: "recent", labelKey: "sortRecent" },
  { value: "title", labelKey: "sortTitle" },
  { value: "author", labelKey: "sortAuthor" },
] as const;

export const BOOK_SORT_OPTIONS: readonly SortOption[] = [
  { value: "reading", labelKey: "sortReading" },
  { value: "recent", labelKey: "sortRecent" },
] as const;

export function writeSortCookie(sort: Sort): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${SORT_COOKIE}=${sort}; path=/; max-age=31536000; samesite=lax${secure}`;
}
