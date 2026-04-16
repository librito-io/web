// Critical fonts served from /static/fonts/ (see src/app.css).
// Stable URLs used by both <link rel="preload"> and @font-face src so
// the browser guarantees a single fetch and reuses preloaded bytes.
export const PRELOAD_FONTS: readonly string[] = [
  "/fonts/bitter-500.woff2",
  "/fonts/noto-sans-400.woff2",
  "/fonts/noto-sans-600.woff2",
  "/fonts/jetbrains-mono-500.woff2",
] as const;
