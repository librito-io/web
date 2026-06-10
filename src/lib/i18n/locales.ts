// Locale constants shared by the client i18n setup (index.ts) and the
// server-side resolver (resolve.ts / hooks.server.ts). Kept free of
// svelte-i18n and $app imports so server code and unit tests can import
// without pulling in loader registration side effects.
export const SUPPORTED_LOCALES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "zh",
  "ru",
  "ar",
  "hi",
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

// Locale choice cookie. Written client-side by setLocale() (not HttpOnly
// — it is a UI preference, not a credential) and read server-side by
// localeSetup (hooks.server.ts) so SSR renders in the user's language.
export const LOCALE_COOKIE = "librito.locale";

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
