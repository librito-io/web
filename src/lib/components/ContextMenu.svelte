<script lang="ts">
  import { _ } from "$lib/i18n";

  let {
    visible = $bindable<boolean>(false),
    x = 0,
    y = 0,
    hasNote = false,
    onCopy,
    onShare,
    onDelete,
  } = $props<{
    visible: boolean;
    x: number;
    y: number;
    hasNote: boolean;
    onCopy: () => void;
    onShare: () => void;
    onDelete: () => void;
  }>();

  let menuEl: HTMLDivElement | undefined = $state();
  let firstItemEl: HTMLButtonElement | undefined = $state();

  function close(): void {
    visible = false;
  }

  function onOutside(e: MouseEvent): void {
    if (!menuEl) return;
    if (!menuEl.contains(e.target as Node)) close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  $effect(() => {
    if (!visible) return;
    firstItemEl?.focus();
    const onScroll = (): void => close();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  });
</script>

<svelte:window onclick={onOutside} onkeydown={onKey} />

{#if visible}
  <div
    bind:this={menuEl}
    class="menu"
    style="left: {x}px; top: {y}px"
    role="menu"
    tabindex="-1"
    aria-label={$_("ctx.menuLabel")}
  >
    <button
      bind:this={firstItemEl}
      role="menuitem"
      onclick={() => {
        onCopy();
        close();
      }}>{$_("ctx.copy")}</button
    >
    <button
      role="menuitem"
      onclick={() => {
        onShare();
        close();
      }}>{$_("ctx.share")}</button
    >
    {#if hasNote}
      <button
        role="menuitem"
        class="danger"
        onclick={() => {
          onDelete();
          close();
        }}>{$_("ctx.deleteNote")}</button
      >
    {/if}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px;
    z-index: 1100;
    min-width: 160px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
  }
  button:hover {
    background: var(--border);
  }
  .danger {
    color: var(--danger);
  }
</style>
