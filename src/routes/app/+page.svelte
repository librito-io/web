<script lang="ts">
  import { _ } from "$lib/i18n";
  import HighlightFeed from "$lib/components/HighlightFeed.svelte";
  import { FEED_SORT_OPTIONS } from "$lib/feed/sort";
  import type { Sort } from "$lib/feed/types";

  let { data } = $props();

  const totalBooks = $derived(new Set(data.items.map((r) => r.book_hash)).size);

  function buildFeedUrl(params: { sort: Sort; cursor: string | null }): string {
    const qs = new URLSearchParams({ sort: params.sort });
    if (params.cursor) qs.set("cursor", params.cursor);
    return `/app/feed?${qs}`;
  }
</script>

<div class="content">
  <div class="page-header">
    <h2>{$_("highlights")}</h2>
    <div class="page-subtitle">
      {$_("subtitle", {
        values: { count: totalBooks, highlights: data.items.length },
      })}
    </div>
  </div>

  <HighlightFeed
    initialItems={data.items}
    initialSort={data.sort}
    initialCursor={data.nextCursor}
    sortOptions={FEED_SORT_OPTIONS}
    fetchUrl={buildFeedUrl}
    emptyMessage={$_("noHighlights")}
    supabase={data.supabase}
    userId={data.user?.id ?? ""}
  />
</div>
