<script lang="ts">
  import { locale } from "$lib/i18n";
  import {
    setLocale,
    SUPPORTED_LOCALES,
    type SupportedLocale,
  } from "$lib/i18n";

  let open = $state(false);
  let wrap: HTMLDivElement | undefined = $state();

  const LABELS: Record<SupportedLocale, string> = {
    en: "English",
    ar: "العربية",
    de: "Deutsch",
    es: "Español",
    fr: "Français",
    hi: "हिन्दी",
    it: "Italiano",
    ja: "日本語",
    ko: "한국어",
    pt: "Português",
    ru: "Русский",
    zh: "简体中文",
  };
  const ORDER: SupportedLocale[] = [
    "en",
    "ar",
    "de",
    "es",
    "fr",
    "hi",
    "it",
    "ja",
    "ko",
    "pt",
    "ru",
    "zh",
  ];

  function toggle(e: MouseEvent): void {
    e.stopPropagation();
    open = !open;
  }

  function pick(code: SupportedLocale): void {
    setLocale(code);
    open = false;
  }

  function onOutsideClick(e: MouseEvent): void {
    if (!wrap) return;
    if (!wrap.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onOutsideClick} />

<div class="lang-wrap" bind:this={wrap}>
  <button class="lang-btn" onclick={toggle} aria-label="Language">
    <svg
      class="lang-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      />
    </svg>
    <span>{($locale ?? "en").toUpperCase()}</span>
  </button>
  <div class="lang-dropdown" class:visible={open}>
    {#each ORDER as code (code)}
      <button
        type="button"
        data-lang={code}
        class:active={$locale === code}
        onclick={() => pick(code)}
      >
        {LABELS[code]}
      </button>
    {/each}
  </div>
</div>
