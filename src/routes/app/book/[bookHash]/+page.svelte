<script lang="ts">
  import { untrack } from "svelte";
  import { _ } from "$lib/i18n";
  import HighlightCard from "$lib/components/HighlightCard.svelte";
  import SortPillRow from "$lib/components/SortPillRow.svelte";
  import InfiniteScroll from "$lib/components/InfiniteScroll.svelte";
  import Breadcrumb from "$lib/components/Breadcrumb.svelte";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import Toast from "$lib/components/Toast.svelte";
  import { BOOK_SORT_OPTIONS, writeSortCookie } from "$lib/feed/sort";
  import type { FeedItem, Sort } from "$lib/feed/types";

  let { data } = $props();

  let sort = $state<Sort>(untrack(() => data.sort));
  let items = $state<FeedItem[]>(untrack(() => data.items));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let done = $state(untrack(() => data.nextCursor === null));

  let ctxVisible = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  let ctxTargetId = $state<string | null>(null);
  let ctxTargetText = $state("");
  let ctxHasNote = $state(false);

  let toastVisible = $state(false);
  let toastMessage = $state("");

  const noteDeleters = new Map<string, () => Promise<void>>();

  function registerNoteEditor(
    highlightId: string,
    handleDelete: () => Promise<void>,
  ): void {
    noteDeleters.set(highlightId, handleDelete);
  }

  function onHighlightMenu(payload: {
    x: number;
    y: number;
    highlightId: string;
    text: string;
    hasNote: boolean;
  }): void {
    ctxX = payload.x;
    ctxY = payload.y;
    ctxTargetId = payload.highlightId;
    ctxTargetText = payload.text;
    ctxHasNote = payload.hasNote;
    ctxVisible = true;
  }

  function showToast(msg: string): void {
    toastMessage = msg;
    toastVisible = true;
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  function onCopy(): void {
    copyText(ctxTargetText);
    showToast($_("toastCopied"));
  }

  async function onShare(): Promise<void> {
    if (navigator.share) {
      try {
        await navigator.share({ text: ctxTargetText });
      } catch {
        // user cancelled
      }
    } else {
      await copyText(ctxTargetText);
      showToast($_("toastCopied"));
    }
  }

  async function onDelete(): Promise<void> {
    if (!ctxTargetId) return;
    const deleter = noteDeleters.get(ctxTargetId);
    if (deleter) {
      await deleter();
      showToast($_("toastNoteDeleted"));
    }
  }

  let fetchGen = 0;
  let inflight = false;

  $effect(() => {
    sort = data.sort;
    items = data.items;
    cursor = data.nextCursor;
    done = data.nextCursor === null;
  });

  async function onSortChange(next: Sort): Promise<void> {
    if (next === sort) return;
    writeSortCookie(next);
    fetchGen += 1;
    inflight = false;
    sort = next;
    cursor = null;
    done = false;
    await loadMore({ replace: true });
  }

  async function loadMore(opts: { replace?: boolean } = {}): Promise<void> {
    if (inflight) return;
    inflight = true;
    const myGen = fetchGen;
    try {
      const qs = new URLSearchParams({ sort, book_hash: data.book.book_hash });
      if (!opts.replace && cursor) qs.set("cursor", cursor);
      const res = await fetch(`/app/feed?${qs}`);
      if (myGen !== fetchGen) return;
      if (!res.ok) throw new Error(`feed fetch ${res.status}`);
      const payload = (await res.json()) as {
        items: FeedItem[];
        nextCursor: string | null;
      };
      if (myGen !== fetchGen) return;
      items = opts.replace ? payload.items : [...items, ...payload.items];
      cursor = payload.nextCursor;
      if (!cursor || payload.items.length === 0) done = true;
    } finally {
      inflight = false;
    }
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
            · {data.catalog.page_count} pages{/if}
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

  <SortPillRow
    options={BOOK_SORT_OPTIONS}
    active={sort}
    onChange={onSortChange}
  />

  <div class="book-list">
    {#if items.length === 0}
      <div class="empty">{$_("noHighlightsInBook")}</div>
    {:else}
      {#each items as item (item.highlight_id)}
        <HighlightCard
          {item}
          supabase={data.supabase}
          userId={data.user?.id ?? ""}
          {onHighlightMenu}
          {registerNoteEditor}
          showHighlightCount={false}
          linkBookText={false}
        />
      {/each}
    {/if}
  </div>

  <InfiniteScroll {loadMore} hasMore={!done} />
</div>

<ContextMenu
  bind:visible={ctxVisible}
  x={ctxX}
  y={ctxY}
  hasNote={ctxHasNote}
  {onCopy}
  {onShare}
  {onDelete}
/>

<Toast bind:visible={toastVisible} message={toastMessage} />

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
