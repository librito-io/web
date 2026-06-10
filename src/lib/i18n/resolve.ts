import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SupportedLocale,
} from "./locales";

function matchSupported(tag: string): SupportedLocale | null {
  const prefix = tag.toLowerCase().split("-")[0];
  return isSupportedLocale(prefix) ? prefix : null;
}

// Server-side locale resolution: explicit cookie choice wins; otherwise
// the Accept-Language header, q-ordered with header order breaking ties,
// primary subtags matched against SUPPORTED_LOCALES; otherwise "en".
export function resolveLocale(
  cookieValue: string | null,
  acceptLanguage: string | null,
): SupportedLocale {
  if (cookieValue && isSupportedLocale(cookieValue)) return cookieValue;
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const candidates = acceptLanguage
    .split(",")
    .map((entry, index) => {
      const [rawTag, ...params] = entry.split(";");
      const qParam = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const parsedQ = qParam ? Number(qParam.slice(2)) : 1;
      return {
        // RFC 7231 §5.3.1: q ranges 0..1; clamp out-of-range values so a
        // crafted q=5 can't outrank legitimate entries.
        tag: rawTag.trim(),
        q: Number.isFinite(parsedQ) ? Math.min(1, Math.max(0, parsedQ)) : 0,
        index,
      };
    })
    // q=0 means "not acceptable" — never a candidate.
    .filter((c) => c.tag !== "" && c.tag !== "*" && c.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const candidate of candidates) {
    const match = matchSupported(candidate.tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}
