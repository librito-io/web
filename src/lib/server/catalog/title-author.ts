function strip(s: string): string {
  // Drop everything that is not a letter, number, or whitespace
  // (Unicode-aware). Then collapse whitespace and trim.
  return s
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeTitleAuthor(
  title: string | null | undefined,
  author: string | null | undefined,
): string | null {
  const t = strip(title ?? "");
  const a = strip(author ?? "");
  if (!t || !a) return null;
  return `${t}|${a}`;
}
