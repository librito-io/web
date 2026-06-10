import { init, register, locale, waitLocale, _ } from "svelte-i18n";
import { get } from "svelte/store";
import { browser } from "$app/environment";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type SupportedLocale,
} from "./locales";

export { SUPPORTED_LOCALES, LOCALE_COOKIE, type SupportedLocale };

const STORAGE_KEY = "librito.locale";

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

let started = false;

// `target` is the server-resolved locale from event.locals.locale
// (cookie → Accept-Language → "en"), passed through the root layout
// load so server render and client hydration agree on the language.
// Await it: resolution means the locale's messages are loaded and the
// $locale store is applied (locale.set on a not-yet-loaded locale only
// settles the store after its json loader flushes, and an argless
// waitLocale() would flush the OLD locale's queue, not the pending one).
//
// svelte-i18n state is module-global. On the server one warm instance
// serves many requests, so after the first init() this must locale.set()
// per call — the `started` guard alone would pin every later request to
// the first request's language. Module-global also means two requests
// resolving concurrently can interleave between this set() and the
// render; the loser SSRs in the wrong language and hydration corrects
// it. Cosmetic, rare, and unfixable without per-request store isolation
// svelte-i18n doesn't offer — accepted in issue #523.
export async function initI18n(target: SupportedLocale): Promise<void> {
  const effective = browser ? migrateLegacyLocale(target) : target;
  if (!started) {
    started = true;
    init({ fallbackLocale: DEFAULT_LOCALE, initialLocale: effective });
    await waitLocale(effective);
  } else if (get(locale) !== effective) {
    await locale.set(effective);
  }
  if (browser) applyDir(effective);
}

export function setLocale(next: SupportedLocale): void {
  locale.set(next);
  if (browser) {
    localStorage.setItem(STORAGE_KEY, next);
    writeLocaleCookie(next);
    applyDir(next);
  }
}

// Pre-#523 clients persisted the locale in localStorage only, which the
// server cannot read. One-time migration: no cookie but a valid stored
// locale → write the cookie and honor the stored choice this load (the
// SSR text was rendered from Accept-Language; hydration repaints it).
function migrateLegacyLocale(target: SupportedLocale): SupportedLocale {
  const hasCookie = document.cookie
    .split("; ")
    .some((c) => c.startsWith(`${LOCALE_COOKIE}=`));
  if (hasCookie) return target;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && isSupportedLocale(stored)) {
    writeLocaleCookie(stored);
    return stored;
  }
  return target;
}

function writeLocaleCookie(loc: SupportedLocale): void {
  // Not HttpOnly (set from JS by design — a UI preference, not a
  // credential); SameSite=Lax; one year.
  document.cookie = `${LOCALE_COOKIE}=${loc}; path=/; max-age=31536000; samesite=lax`;
}

function applyDir(loc: SupportedLocale): void {
  document.documentElement.dir = loc === "ar" ? "rtl" : "ltr";
  document.documentElement.lang = loc;
}

export { locale, waitLocale, _ };
