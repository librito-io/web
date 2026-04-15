// Critical fonts preloaded in the root layout to avoid FOUT / CLS.
// Vite hashes these URLs at build time; `?url` imports give the final
// public path regardless of bundler config.

import bitter500 from "@fontsource/bitter/files/bitter-latin-500-normal.woff2?url";
import notoSans400 from "@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2?url";
import notoSans600 from "@fontsource/noto-sans/files/noto-sans-latin-600-normal.woff2?url";
import jetbrainsMono500 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url";
import materialSymbols from "material-symbols/material-symbols-outlined.woff2?url";

export const PRELOAD_FONTS: readonly string[] = [
  bitter500,
  notoSans400,
  notoSans600,
  jetbrainsMono500,
  materialSymbols,
] as const;
