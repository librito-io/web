<script lang="ts">
  import { untrack } from "svelte";
  import { _ } from "$lib/i18n";
  import HighlightCard from "$lib/components/HighlightCard.svelte";
  import SortPillRow from "$lib/components/SortPillRow.svelte";
  import InfiniteScroll from "$lib/components/InfiniteScroll.svelte";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import Toast from "$lib/components/Toast.svelte";
  import { FEED_SORT_OPTIONS, writeSortCookie } from "$lib/feed/sort";
  import type { FeedRow, Sort } from "$lib/feed/types";

  let { data } = $props();

  let sort = $state<Sort>(untrack(() => data.sort));
  let items = $state<FeedRow[]>(untrack(() => data.rows));
  let cursor = $state<string | null>(untrack(() => data.nextCursor));
  let done = $state(untrack(() => data.nextCursor === null));

  const totalBooks = $derived(new Set(items.map((r) => r.book_hash)).size);

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
    items = data.rows;
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
      const qs = new URLSearchParams({ sort });
      if (!opts.replace && cursor) qs.set("cursor", cursor);
      const res = await fetch(`/app/feed?${qs}`);
      if (myGen !== fetchGen) return;
      if (!res.ok) throw new Error(`feed fetch ${res.status}`);
      const payload = (await res.json()) as {
        rows: FeedRow[];
        nextCursor: string | null;
      };
      if (myGen !== fetchGen) return;
      items = opts.replace ? payload.rows : [...items, ...payload.rows];
      cursor = payload.nextCursor;
      if (!cursor || payload.rows.length === 0) done = true;
    } finally {
      inflight = false;
    }
  }
</script>

<div class="content">
  <div class="page-header">
    <h2>{$_("highlights")}</h2>
    <div class="page-subtitle">
      {$_("subtitle", {
        values: { count: totalBooks, highlights: items.length },
      })}
    </div>
  </div>

  <SortPillRow
    options={FEED_SORT_OPTIONS}
    active={sort}
    onChange={onSortChange}
  />

  <div class="book-list">
    {#if items.length === 0}
      <div class="empty">{$_("noHighlights")}</div>
    {:else}
      {#each items as row (row.highlight_id)}
        <HighlightCard
          {row}
          supabase={data.supabase}
          userId={data.user?.id ?? ""}
          {onHighlightMenu}
          {registerNoteEditor}
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
