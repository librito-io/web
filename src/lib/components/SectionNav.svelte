<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Spring } from "svelte/motion";
  import { SPRING, prefersReducedMotion } from "$lib/motion";

  /**
   * Top-level section switcher with a sliding filled-pill indicator.
   * First consumer of the motion language (docs/dev/motion-language.md):
   * the indicator is a value-driven, interruptible `Spring` — Svelte's
   * wheelhouse, no library needed.
   *
   * Route-ready: an item with `href` renders an `<a>` (real navigation);
   * without it, a `<button>` calling `onSelect` (in-page toggle). The
   * `/app` sections are toggle-mode today; the future Reading List page
   * just adds `href` and lifts this into the shared layout so the slide
   * survives the cross-page nav.
   */
  type NavItem = { key: string; label: string; href?: string };

  let { items, active, onSelect } = $props<{
    items: readonly NavItem[];
    active: string;
    onSelect: (key: string) => void;
  }>();

  let nav = $state<HTMLElement>();
  // Element refs per item key — plain object; read imperatively in
  // measure(), so it needn't be reactive state.
  const refs: Record<string, HTMLElement> = {};

  // Indicator geometry (offset + width, px) driven by a low-overshoot
  // spring so re-triggers retarget mid-slide instead of snapping.
  const ind = new Spring({ x: 0, w: 0 }, SPRING.snappy);
  let measured = $state(false);

  function measure(animate: boolean): void {
    const el = refs[active];
    if (!el || !nav) return;
    const next = { x: el.offsetLeft, w: el.offsetWidth };
    if (animate && !prefersReducedMotion()) {
      ind.target = next;
    } else {
      ind.set(next, { instant: true });
    }
    measured = true;
  }

  onMount(() => {
    // Snap into place on first paint (no slide-in from x=0).
    measure(false);
    // Re-measure on container resize: viewport changes, font swap, or a
    // locale switch that changes label widths. Snapping (not sliding) is
    // correct here — it's a layout change, not a user-initiated move.
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(nav!);
    return () => ro.disconnect();
  });

  // Slide when the active section changes (after the initial measure).
  $effect(() => {
    active;
    if (untrack(() => measured)) measure(true);
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = items.findIndex((it: NavItem) => it.key === active);
    if (i < 0) return;
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = items[(i + delta + items.length) % items.length];
    refs[next.key]?.focus();
    if (!next.href) onSelect(next.key);
  }
</script>

<div class="nav" role="tablist" bind:this={nav}>
  <span
    class="indicator"
    aria-hidden="true"
    style:transform="translateX({ind.current.x}px)"
    style:width="{ind.current.w}px"
    style:opacity={measured ? 1 : 0}
  ></span>

  {#each items as item (item.key)}
    {#if item.href}
      <a
        bind:this={refs[item.key]}
        class="item"
        class:active={item.key === active}
        href={item.href}
        role="tab"
        aria-selected={item.key === active}
        tabindex={item.key === active ? 0 : -1}
        onkeydown={onKeydown}
      >
        {item.label}
      </a>
    {:else}
      <button
        bind:this={refs[item.key]}
        type="button"
        class="item"
        class:active={item.key === active}
        role="tab"
        aria-selected={item.key === active}
        tabindex={item.key === active ? 0 : -1}
        onclick={() => onSelect(item.key)}
        onkeydown={onKeydown}
      >
        {item.label}
      </button>
    {/if}
  {/each}
</div>

<style>
  .nav {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    /* No track background or outline — per design, only the active pill
       shows, and it slides. */
  }

  .indicator {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    border-radius: 999px;
    background: #dedede;
    z-index: 0;
    pointer-events: none;
    /* Fade in once first-measured (avoids a flash at x=0,w=0 pre-mount);
       opacity is composited, safe under reduced motion. */
    transition: opacity var(--dur-3) var(--ease-out);
    will-change: transform, width;
  }

  .item {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    height: 42px;
    background: transparent;
    border: none;
    border-radius: 999px;
    padding: 0 16px;
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    line-height: 1;
    letter-spacing: var(--tracking-sm);
    color: #8b8f94;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color var(--dur-3) var(--ease-out),
      transform var(--dur-fast) var(--ease-out);
  }

  .item:hover {
    color: #c9cdd2;
  }

  .item.active {
    /* Dark text reads on the light sliding pill. */
    color: #0a0c0f;
  }

  .item:active {
    transform: scale(var(--press-scale));
  }

  .item:focus-visible {
    outline: 2px solid #5b8def;
    outline-offset: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    .indicator {
      transition: none;
    }
  }
</style>
