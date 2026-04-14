export type RelativeStrings = {
  justNow: string;
  minutes: string; // "{n}m ago"
  hours: string; // "{n}h ago"
  yesterday: string;
};

type Options = {
  now?: number;
  strings: RelativeStrings;
  locale?: string;
};

export function relativeTime(
  value: string | number | Date | null | undefined,
  opts: Options,
): string {
  if (value === null || value === undefined) return "";
  const then =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const now = opts.now ?? Date.now();
  const deltaMs = Math.max(0, now - then);
  const minutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(deltaMs / 3_600_000);
  const days = Math.floor(deltaMs / (24 * 3_600_000));

  if (minutes < 1) return opts.strings.justNow;
  if (minutes < 60) return opts.strings.minutes.replace("{n}", String(minutes));
  if (hours < 24) return opts.strings.hours.replace("{n}", String(hours));
  if (days < 2) return opts.strings.yesterday;

  return new Date(then).toLocaleDateString(opts.locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
