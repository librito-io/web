<script lang="ts">
  import { _ } from "$lib/i18n";

  let {
    visible = $bindable<boolean>(false),
    x = 0,
    y = 0,
    targetId = null,
    hasNote = false,
    onCopy,
    onShare,
    onDelete,
  } = $props<{
    visible: boolean;
    x: number;
    y: number;
    targetId?: string | null;
    hasNote: boolean;
    onCopy: () => void;
    onShare: () => void;
    onDelete: () => void;
  }>();

  let menuEl: HTMLDivElement | undefined = $state();
  let clampedX = $state(0);
  let clampedY = $state(0);

  function close(): void {
    visible = false;
  }

  function onOutside(e: MouseEvent): void {
    // Right-click on Mac fires `click` with button=2 before `contextmenu` in
    // some browsers; ignore so reopening the menu doesn't immediately close.
    if (e.button === 2) return;
    if (!menuEl) return;
    if (!menuEl.contains(e.target as Node)) close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  function preventScroll(e: Event): void {
    e.preventDefault();
  }

  $effect(() => {
    if (!visible) return;
    // Start at requested coords, then clamp after measuring.
    clampedX = x;
    clampedY = y;

    // Focus the menu container, not the first button. Focusing a button
    // matches `:focus-visible` on the initial post-load programmatic focus
    // (before any user pointer interaction has set the browser's heuristic
    // to "pointer mode"), causing a spurious focus ring on first open.
    // The container has tabindex="-1" and keeps Escape/Tab working.
    menuEl?.focus({ preventScroll: true });

    // Scroll lock keeps the scrollbar gutter visible; hiding the gutter
    // reflows the page and the menu would jump.
    window.addEventListener("wheel", preventScroll, { passive: false });
    window.addEventListener("touchmove", preventScroll, { passive: false });

    const onScroll = (): void => close();
    window.addEventListener("scroll", onScroll, true);

    // Flip anchor when overflowing the inline edge. RTL renders the menu with
    // `translateX(-100%)` (see [dir="rtl"] .ctx-menu in app.css), so its
    // visual rect sits to the left of `clampedX`; LTR sits to the right.
    // rAF (not microtask) so the just-written `left/top` style is flushed and
    // getBoundingClientRect reflects the requested position.
    const raf = requestAnimationFrame(() => {
      if (!menuEl) return;
      const r = menuEl.getBoundingClientRect();
      const isRtl = document.documentElement.dir === "rtl";
      const margin = 8;
      if (isRtl) {
        if (r.left < margin) {
          clampedX = Math.min(window.innerWidth - margin, x + r.width);
        }
      } else {
        if (r.right > window.innerWidth - margin) {
          clampedX = Math.max(margin, x - r.width);
        }
      }
      if (r.bottom > window.innerHeight - margin) {
        clampedY = Math.max(margin, window.innerHeight - r.height - margin);
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("wheel", preventScroll);
      window.removeEventListener("touchmove", preventScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  });
</script>

<svelte:window onclick={onOutside} onkeydown={onKey} />

<div
  bind:this={menuEl}
  class="ctx-menu"
  class:visible
  style="left: {clampedX}px; top: {clampedY}px"
  role="menu"
  tabindex="-1"
  aria-label={$_("ctxMenuLabel")}
>
  <button
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
