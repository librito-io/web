<script lang="ts">
  import { _ } from "$lib/i18n";
  import type { Sort } from "$lib/feed/types";
  import type { SortOption } from "$lib/feed/sort";

  let {
    options,
    active,
    onChange,
    variant = "pill",
  } = $props<{
    options: readonly SortOption[];
    active: Sort;
    onChange: (value: Sort) => void;
    // "pill": bordered standalone row (book detail). "plain": borderless
    // text labels for the section bar — outlines dropped per design;
    // sorting UI is intentionally minimal for now (needs more thought).
    variant?: "pill" | "plain";
  }>();
</script>

<div class="pill-row" class:plain={variant === "plain"} role="tablist">
  {#each options as opt (opt.value)}
    <button
      type="button"
      role="tab"
      aria-selected={opt.value === active}
      class="pill"
      class:active={opt.value === active}
      onclick={() => onChange(opt.value)}
    >
      {$_(opt.labelKey)}
    </button>
  {/each}
</div>

<style>
  .pill-row {
    display: flex;
    gap: 8px;
    padding: 16px 0 24px;
    flex-wrap: wrap;
  }
  .pill {
    background: transparent;
    color: #888;
    border: 1px solid #2a2a2a;
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 0.875rem;
    font-family: inherit;
    letter-spacing: var(--tracking-sm);
    cursor: pointer;
    transition:
      background var(--dur-2) var(--ease-hover),
      color var(--dur-2) var(--ease-hover),
      border-color var(--dur-2) var(--ease-hover),
      transform var(--dur-fast) var(--ease-out);
  }
  .pill:hover {
    color: #ccc;
    border-color: #3a3a3a;
  }
  .pill.active {
    background: #2a2a2a;
    color: #dedede;
    border-color: #3a3a3a;
  }
  .pill:active {
    transform: scale(var(--press-scale));
  }

  /* Plain variant — borderless text labels for the section bar. */
  .pill-row.plain {
    padding: 0;
    gap: 4px;
  }
  .pill-row.plain .pill {
    border-color: transparent;
    background: transparent;
    padding: 6px 10px;
    line-height: 1;
    color: #6f7479;
  }
  .pill-row.plain .pill:hover {
    color: #c9cdd2;
  }
  .pill-row.plain .pill.active {
    background: transparent;
    border-color: transparent;
    color: #dedede;
  }
</style>
