import { init, register, locale, waitLocale, _ } from "svelte-i18n";
import { browser } from "$app/environment";

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

const STORAGE_KEY = "librito.locale";
const DEFAULT_LOCALE: SupportedLocale = "en";

register("en", () => import("./en.json"));
register("es", () => import("./es.json"));
register("fr", () => import("./fr.json"));
register("de", () => import("./de.json"));
register("it", () => import("./it.json"));
register("pt", () => import("./pt.json"));
register("ja", () => import("./ja.json"));
register("ko", () => import("./ko.json"));
register("zh", () => import("./zh.json"));
register("ru", () => import("./ru.json"));
register("ar", () => import("./ar.json"));
register("hi", () => import("./hi.json"));

export function detectLocale(
  stored: string | null,
  navigatorLang: string | null,
): SupportedLocale {
  if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
    return stored as SupportedLocale;
  }
  if (navigatorLang) {
    const prefix = navigatorLang.split("-")[0].toLowerCase();
    if ((SUPPORTED_LOCALES as readonly string[]).includes(prefix)) {
      return prefix as SupportedLocale;
    }
  }
  return DEFAULT_LOCALE;
}

let started = false;

export function initI18n(): void {
  if (started) return;
  started = true;
  const initialLocale = browser
    ? detectLocale(
        localStorage.getItem(STORAGE_KEY),
        navigator.language ?? null,
      )
    : DEFAULT_LOCALE;
  init({ fallbackLocale: DEFAULT_LOCALE, initialLocale });
  if (browser) applyDir(initialLocale);
}

export function setLocale(next: SupportedLocale): void {
  locale.set(next);
  if (browser) {
    localStorage.setItem(STORAGE_KEY, next);
    applyDir(next);
  }
}

function applyDir(loc: SupportedLocale): void {
  document.documentElement.dir = loc === "ar" ? "rtl" : "ltr";
  document.documentElement.lang = loc;
}

export { locale, waitLocale, _ };
