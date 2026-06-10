import type { SupportedLocale } from "./i18n/locales";

// Critical fonts served from /static/fonts/ (see src/app.css).
// Stable URLs used by both <link rel="preload"> and @font-face src so
// the browser guarantees a single fetch and reuses preloaded bytes.
export const PRELOAD_FONTS: readonly string[] = [
  "/fonts/inter-400.woff2",
  "/fonts/inter-600.woff2",
  "/fonts/inter-700.woff2",
  "/fonts/inter-variable.woff2",
  "/fonts/literata-400.woff2",
  "/fonts/literata-400-italic.woff2",
] as const;

// Locale-gated Noto subset preloads (issue #416). Only Arabic and
// Devanagari ship a single-file fontsource script subset (~50K/weight)
// that can be self-hosted and preloaded; the CJK packages slice each
// weight into ~120 unicode-range files with no preloadable whole, so
// ja/ko/zh stay on the on-demand fontsource `swap` path. The matching
// woff2 are self-hosted in /static/fonts/ with font-display: optional,
// so a cold-cache ar/hi visit renders the script at first paint instead
// of FOUTing from the system fallback. Latin/Cyrillic/CJK locales emit
// nothing and pay zero extra bytes.
const NOTO_PRELOADS: Partial<Record<SupportedLocale, readonly string[]>> = {
  ar: [
    "/fonts/noto-sans-arabic-400.woff2",
    "/fonts/noto-sans-arabic-600.woff2",
  ],
  hi: [
    "/fonts/noto-sans-devanagari-400.woff2",
    "/fonts/noto-sans-devanagari-600.woff2",
  ],
};

export function notoPreloadForLocale(
  locale: SupportedLocale,
): readonly string[] {
  return NOTO_PRELOADS[locale] ?? [];
}
