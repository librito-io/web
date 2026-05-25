export type RelativeStrings = {
  justNow: string;
  minuteAgo: string;
  minutesAgo: string; // "{n} minutes ago"
  hourAgo: string;
  hoursAgo: string; // "{n} hours ago"
  dayAgo: string;
  daysAgo: string; // "{n} days ago"
  weekAgo: string;
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
  if (minutes === 1) return opts.strings.minuteAgo;
  if (minutes < 60)
    return opts.strings.minutesAgo.replace("{n}", String(minutes));
  if (hours === 1) return opts.strings.hourAgo;
  if (hours < 24) return opts.strings.hoursAgo.replace("{n}", String(hours));
  if (days === 1) return opts.strings.dayAgo;
  if (days < 7) return opts.strings.daysAgo.replace("{n}", String(days));
  if (days < 14) return opts.strings.weekAgo;

  const thenDate = new Date(then);
  const nowDate = new Date(now);
  const locale = opts.locale ?? "en-US";
  const sameYear = thenDate.getFullYear() === nowDate.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(thenDate);
}
