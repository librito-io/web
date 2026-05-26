<script lang="ts">
  import { _ } from "$lib/i18n";
  import HighlightFeed from "$lib/components/HighlightFeed.svelte";
  import Breadcrumb from "$lib/components/Breadcrumb.svelte";
  import { BOOK_SORT_OPTIONS } from "$lib/feed/sort";
  import { buildFeedUrl } from "$lib/feed/url";

  let { data } = $props();
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
      <h2 class="book-detail-title" dir="auto">
        {data.book.title || $_("untitled")}
      </h2>
      <div class="book-author" dir="auto">
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
        {#if data.catalog.description_provider === "google_books"}
          <p class="catalog-attribution">via Google Books</p>
        {/if}
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
    fetchUrl={(p) => buildFeedUrl({ ...p, bookHash: data.book.book_hash })}
    emptyMessage={$_("noHighlightsInBook")}
    supabase={data.supabase}
    userId={data.user?.id ?? ""}
    cardProps={{ linkBookText: false }}
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

  .meta :global(.book-author) {
    font-size: 1.125rem;
    letter-spacing: var(--tracking-md);
  }

  .catalog-line {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    letter-spacing: var(--tracking-sm);
    color: #9e9fa2;
  }

  .catalog-description {
    margin-top: 0.75rem;
    /* 16px @400 description body. 1.5 leading (= 24px) matches rsms.me's
       paragraph rhythm. letter-spacing follows the formula/lab value
       (`--tracking-base` = -0.011em, lab Inter @400 at 16px = -1.1%);
       picked after eyeballing against rsms's `normal` and a 1.375
       (22px) leading option. */
    font-size: 1rem;
    line-height: 1.5;
    letter-spacing: var(--tracking-base);
  }

  .catalog-attribution {
    margin-top: 0.25rem;
    font-size: 0.75rem;
    letter-spacing: var(--tracking-xs);
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
    letter-spacing: var(--tracking-xs);
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
