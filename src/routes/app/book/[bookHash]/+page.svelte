<script lang="ts">
  import { _ } from "$lib/i18n";
  import HighlightFeed from "$lib/components/HighlightFeed.svelte";
  import Breadcrumb from "$lib/components/Breadcrumb.svelte";
  import { BOOK_SORT_OPTIONS } from "$lib/feed/sort";
  import type { Sort } from "$lib/feed/types";

  let { data } = $props();

  function buildFeedUrl(params: { sort: Sort; cursor: string | null }): string {
    const qs = new URLSearchParams({
      sort: params.sort,
      book_hash: data.book.book_hash,
    });
    if (params.cursor) qs.set("cursor", params.cursor);
    return `/app/feed?${qs}`;
  }
</script>

<div class="content">
  <Breadcrumb href="/app" label={$_("backToFeed")} />

  <header class="book-header">
    <img
      class="book-cover"
      src={data.catalog.cover_url}
      alt={`Cover of ${data.book.title || $_("untitled")}`}
      width="200"
      height="300"
      loading="eager"
    />
    <div class="meta">
      <h2 dir="auto">{data.book.title || $_("untitled")}</h2>
      <div class="page-subtitle" dir="auto">
        {data.book.author || $_("unknownAuthor")}
      </div>
      {#if data.catalog.publisher || data.catalog.published_date || data.catalog.page_count}
        <p class="catalog-line">
          {#if data.catalog.publisher}{data.catalog.publisher}{/if}
          {#if data.catalog.published_date}
            · {data.catalog.published_date}{/if}
          {#if data.catalog.page_count}
            · {$_("pageCount", {
              values: { count: data.catalog.page_count },
            })}{/if}
        </p>
      {/if}
      {#if data.catalog.description}
        <p class="catalog-description">{data.catalog.description}</p>
        <p class="catalog-attribution">
          via {data.catalog.description_provider === "google_books"
            ? "Google Books"
            : "Open Library"}
        </p>
      {/if}
      {#if data.catalog.subjects?.length}
        <ul class="catalog-subjects">
          {#each data.catalog.subjects.slice(0, 5) as s}
            <li>{s}</li>
          {/each}
        </ul>
      {/if}
    </div>
  </header>

  <HighlightFeed
    initialItems={data.items}
    initialSort={data.sort}
    initialCursor={data.nextCursor}
    sortOptions={BOOK_SORT_OPTIONS}
    fetchUrl={buildFeedUrl}
    emptyMessage={$_("noHighlightsInBook")}
    supabase={data.supabase}
    userId={data.user?.id ?? ""}
    cardProps={{ showHighlightCount: false, linkBookText: false }}
  />
</div>

<style>
  .book-header {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
    margin-bottom: 1.5rem;
  }

  .book-cover {
    flex-shrink: 0;
    width: 200px;
    height: 300px;
    object-fit: cover;
    border-radius: 4px;
    background: #2a2a2a;
  }

  .meta {
    flex: 1;
    min-width: 0;
  }

  .catalog-line {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    color: var(--color-muted, #888);
  }

  .catalog-description {
    margin-top: 0.75rem;
    font-size: 0.9375rem;
    line-height: 1.6;
  }

  .catalog-attribution {
    margin-top: 0.25rem;
    font-size: 0.75rem;
    color: var(--color-muted, #888);
  }

  .catalog-subjects {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    list-style: none;
    padding: 0;
    margin-top: 0.75rem;
  }

  .catalog-subjects li {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: #2a2a2a;
    color: #ccc;
  }

  @media (max-width: 480px) {
    .book-header {
      flex-direction: column;
    }

    .book-cover {
      width: 120px;
      height: 180px;
    }
  }
</style>
