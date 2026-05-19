export function formatDate(
  dateStr: string | null,
  fallback: string,
  locale?: string,
): string {
  if (!dateStr) return fallback;
  return new Date(dateStr).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
