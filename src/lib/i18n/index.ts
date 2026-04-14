import { init, register, locale, waitLocale, _ } from "svelte-i18n";

const DEFAULT_LOCALE = "en";

register("en", () => import("./en.json"));

let started = false;

export function initI18n(initialLocale: string = DEFAULT_LOCALE) {
  if (started) return;
  started = true;
  init({
    fallbackLocale: DEFAULT_LOCALE,
    initialLocale,
  });
}

export { locale, waitLocale, _ };
