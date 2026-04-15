<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "$lib/i18n";

  let { loadMore, hasMore } = $props<{
    loadMore: () => Promise<void>;
    hasMore: boolean;
  }>();

  let sentinel: HTMLDivElement | undefined = $state();
  let loading = $state(false);
  let errored = $state(false);

  async function trigger(): Promise<void> {
    if (loading || !hasMore) return;
    loading = true;
    errored = false;
    try {
      await loadMore();
    } catch {
      errored = true;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) trigger();
      },
      { rootMargin: "400px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

{#if hasMore}
  <div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>
  <div class="status" aria-live="polite">
    {#if loading}
      <span class="loading-text">{$_("loading")}</span>
    {:else if errored}
      <button class="retry" onclick={trigger}>{$_("retry")}</button>
    {/if}
  </div>
{/if}

<style>
  .sentinel {
    height: 1px;
  }
  .status {
    text-align: center;
    padding: 24px 0;
    color: #888;
    font-size: 0.9rem;
  }
  .loading-text {
    opacity: 0.7;
  }
  .retry {
    background: #2a2a2a;
    color: #e8e8e8;
    border: 1px solid #3a3a3a;
    border-radius: 999px;
    padding: 6px 16px;
    cursor: pointer;
  }
  .retry:hover {
    background: #333;
  }
</style>
