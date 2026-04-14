<script lang="ts">
  import { _ } from "$lib/i18n";
  import LanguageSelector from "./LanguageSelector.svelte";

  let { open = $bindable<boolean>(false), onLogout } = $props<{
    open: boolean;
    onLogout: () => void | Promise<void>;
  }>();

  function close() {
    open = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="overlay" role="dialog" aria-modal="true">
    <button class="close" onclick={close} aria-label={$_("common.close")}>
      ×
    </button>

    <nav class="primary">
      <a href="/app" onclick={close}>{$_("menu.library")}</a>
      <a href="/app/devices" onclick={close}>{$_("menu.devices")}</a>
    </nav>

    <div class="secondary">
      <LanguageSelector />
      <button
        class="logout"
        onclick={async () => {
          close();
          await onLogout();
        }}>{$_("menu.logout")}</button
      >
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--bg);
    z-index: 900;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 48px;
    animation: fade-in 160ms ease-out;
  }
  .close {
    position: absolute;
    top: 20px;
    right: 20px;
    font-size: 2rem;
    color: var(--text-secondary);
  }
  .primary {
    display: flex;
    flex-direction: column;
    gap: 16px;
    font-size: 1.6rem;
    text-align: center;
  }
  .primary a {
    padding: 8px 16px;
  }
  .secondary {
    display: flex;
    flex-direction: column;
    gap: 24px;
    align-items: center;
  }
  .logout {
    color: var(--danger);
    font-weight: 500;
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
