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
