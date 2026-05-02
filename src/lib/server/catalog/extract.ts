import type { CatalogMetadata } from "./types";

interface OpenLibraryAuthor {
  name?: string;
}
interface OpenLibraryPublisher {
  name?: string;
}
interface OpenLibraryDataDoc {
  title?: string;
  authors?: OpenLibraryAuthor[];
  publishers?: OpenLibraryPublisher[];
  number_of_pages?: number;
  publish_date?: string;
  subjects?: { name: string }[] | string[];
  cover?: { large?: string; medium?: string; small?: string };
  url?: string;
  identifiers?: { isbn_10?: string[]; [key: string]: string[] | undefined };
  works?: { key: string }[];
}

interface OpenLibraryWork {
  description?: string | { value: string };
  subjects?: string[];
}

function flattenSubjects(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .map((s) => (typeof s === "string" ? s : (s as { name?: string }).name))
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return out.length ? out : undefined;
}

export function extractOpenLibraryMetadata(
  data: OpenLibraryDataDoc | null,
  work: OpenLibraryWork | null,
): CatalogMetadata {
  if (!data) return {};
  const out: CatalogMetadata = {};

  if (data.title) out.title = data.title;
  if (data.authors?.length) {
    const names = data.authors.map((a) => a.name).filter(Boolean);
    if (names.length) out.author = names.join(", ");
  }
  if (data.publishers?.length) {
    const names = data.publishers.map((p) => p.name).filter(Boolean);
    if (names.length) out.publisher = names.join(", ");
  }
  if (typeof data.number_of_pages === "number" && data.number_of_pages > 0) {
    out.page_count = data.number_of_pages;
  }
  if (data.publish_date) out.published_date = data.publish_date;
  const subjects =
    flattenSubjects(data.subjects) ?? flattenSubjects(work?.subjects);
  if (subjects) out.subjects = subjects.slice(0, 30);
  if (data.identifiers?.isbn_10?.[0]) out.isbn_10 = data.identifiers.isbn_10[0];
  if (data.url) out.source_url = data.url;

  let description: string | undefined;
  if (typeof work?.description === "string") description = work.description;
  else if (work?.description && typeof work.description.value === "string") {
    description = work.description.value;
  }
  if (description) {
    out.description = description.trim();
    out.description_provider = "openlibrary";
  }
  return out;
}

export interface GoogleBooksItem {
  id: string;
  volumeInfo: {
    title?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    pageCount?: number;
    language?: string;
    categories?: string[];
    imageLinks?: { thumbnail?: string; large?: string };
    industryIdentifiers?: { type: string; identifier: string }[];
  };
}

export function extractGoogleBooksMetadata(
  item: GoogleBooksItem,
): CatalogMetadata {
  const v = item.volumeInfo ?? {};
  const out: CatalogMetadata = { google_volume_id: item.id };
  if (v.title) out.title = v.title;
  if (v.authors?.length) out.author = v.authors.join(", ");
  if (v.publisher) out.publisher = v.publisher;
  if (v.publishedDate) out.published_date = v.publishedDate;
  if (typeof v.pageCount === "number" && v.pageCount > 0)
    out.page_count = v.pageCount;
  if (v.language) out.language = v.language;
  if (v.categories?.length) out.subjects = v.categories.slice(0, 30);
  if (v.description) {
    out.description = v.description;
    out.description_provider = "google_books";
  }
  const isbn10 = v.industryIdentifiers?.find(
    (i) => i.type === "ISBN_10",
  )?.identifier;
  if (isbn10) out.isbn_10 = isbn10;
  return out;
}
