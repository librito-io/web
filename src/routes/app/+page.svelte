<script lang="ts">
  import { _ } from "$lib/i18n";
  import HighlightFeed from "$lib/components/HighlightFeed.svelte";
  import { FEED_SORT_OPTIONS } from "$lib/feed/sort";
  import { buildFeedUrl } from "$lib/feed/url";

  let { data } = $props();

  const totalBooks = $derived(new Set(data.items.map((r) => r.book_hash)).size);
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
