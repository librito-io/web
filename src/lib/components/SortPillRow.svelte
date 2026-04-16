<script lang="ts">
  import { _ } from "$lib/i18n";
  import type { Sort } from "$lib/feed/types";
  import type { SortOption } from "$lib/feed/sort";

  let { options, active, onChange } = $props<{
    options: readonly SortOption[];
    active: Sort;
    onChange: (value: Sort) => void;
  }>();
</script>

<div class="pill-row" role="tablist">
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
    font-size: 0.9rem;
    font-family: inherit;
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s,
      border-color 0.15s;
  }
  .pill:hover {
    color: #ccc;
    border-color: #3a3a3a;
  }
  .pill.active {
    background: #2a2a2a;
    color: #e8e8e8;
    border-color: #3a3a3a;
  }
</style>
