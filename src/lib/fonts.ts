// Critical fonts preloaded in the root layout to avoid FOUT / CLS.
// Vite hashes these URLs at build time; `?url` imports give the final
// public path regardless of bundler config.

import bitter500 from "@fontsource/bitter/files/bitter-latin-500-normal.woff2?url";
import notoSans400 from "@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2?url";
import notoSans600 from "@fontsource/noto-sans/files/noto-sans-latin-600-normal.woff2?url";
import jetbrainsMono500 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url";

// Vite dev-mode appends ?import&url to ?url imports; fontsource's
// bundled CSS references the raw file. Strip the query so our preload
// hrefs match the URL the browser fetches via @font-face, letting
// Safari (which does not dedupe mismatched URLs) reuse the preload.
const stripQuery = (u: string): string => u.split("?")[0];

export const PRELOAD_FONTS: readonly string[] = [
  stripQuery(bitter500),
  stripQuery(notoSans400),
  stripQuery(notoSans600),
  stripQuery(jetbrainsMono500),
] as const;
