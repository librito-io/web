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
    <span class="material-symbols-outlined">language</span>
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
