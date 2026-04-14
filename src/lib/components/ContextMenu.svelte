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

<div
  bind:this={menuEl}
  class="ctx-menu"
  class:visible
  style="left: {x}px; top: {y}px"
  role="menu"
  tabindex="-1"
  aria-label={$_("ctxMenuLabel")}
>
  <button
    bind:this={firstItemEl}
    role="menuitem"
    onclick={() => {
      onCopy();
      close();
    }}
  >
    {$_("ctxCopy")}
  </button>
  <button
    role="menuitem"
    onclick={() => {
      onShare();
      close();
    }}
  >
    {$_("ctxShare")}
  </button>
  {#if hasNote}
    <button
      role="menuitem"
      class="destructive"
      onclick={() => {
        onDelete();
        close();
      }}
    >
      {$_("ctxDeleteNote")}
    </button>
  {/if}
</div>
