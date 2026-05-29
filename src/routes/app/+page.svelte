<script lang="ts">
  import { untrack } from "svelte";
  import { _ } from "$lib/i18n";
  import HighlightFeed from "$lib/components/HighlightFeed.svelte";
  import SectionNav from "$lib/components/SectionNav.svelte";
  import SortPillRow from "$lib/components/SortPillRow.svelte";
  import ReadingListPlaceholder from "$lib/components/ReadingListPlaceholder.svelte";
  import { FEED_SORT_OPTIONS } from "$lib/feed/sort";
  import { buildFeedUrl } from "$lib/feed/url";
  import type { Sort } from "$lib/feed/types";

  let { data } = $props();

  // Top-level sections. "readingList" is a placeholder for now; the swap
  // to a real /app/reading-list route is a follow-up (SectionNav already
  // supports per-item `href`). See docs/dev/motion-language.md consumers.
  let activeSection = $state<"highlights" | "readingList">("highlights");

  // Sort lives here (the control sits on the section bar) and is fed to
  // HighlightFeed as `controlledSort` — it owns the cookie write + refetch.
  let sort = $state<Sort>(untrack(() => data.sort));

  const sections = $derived([
    { key: "highlights", label: $_("highlights") },
    { key: "readingList", label: $_("readingList") },
  ]);
</script>

<div class="content feed-page">
  <div class="section-bar">
    <SectionNav
      items={sections}
      active={activeSection}
      onSelect={(key) => (activeSection = key as "highlights" | "readingList")}
    />
    {#if activeSection === "highlights"}
      <SortPillRow
        variant="plain"
        options={FEED_SORT_OPTIONS}
        active={sort}
        onChange={(next) => (sort = next)}
      />
    {/if}
  </div>

  {#if activeSection === "highlights"}
    <HighlightFeed
      initialItems={data.items}
      initialSort={data.sort}
      initialCursor={data.nextCursor}
      controlledSort={sort}
      fetchUrl={buildFeedUrl}
      emptyMessage={$_("noHighlights")}
      supabase={data.supabase}
      userId={data.user?.id ?? ""}
    />
  {:else}
    <ReadingListPlaceholder />
  {/if}
</div>
