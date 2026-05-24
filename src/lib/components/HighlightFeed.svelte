<script lang="ts">
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { untrack } from "svelte";
  import Masonry from "svelte-bricks";
  import { _ } from "$lib/i18n";
  import HighlightCard from "./HighlightCard.svelte";
  import SortPillRow from "./SortPillRow.svelte";
  import InfiniteScroll from "./InfiniteScroll.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import Toast from "./Toast.svelte";
  import { installHighlightContextMenuListener } from "$lib/contextMenu/highlightDocListener";
  import { writeSortCookie, type SortOption } from "$lib/feed/sort";
  import type { FeedItem, Sort } from "$lib/feed/types";
  import { copyText } from "$lib/clipboard";

  type CardFlags = {
    showChapterHeading?: boolean;
    linkBookText?: boolean;
  };

  let {
    initialItems,
    initialSort,
    initialCursor,
    sortOptions,
    fetchUrl,
    emptyMessage,
    supabase,
    userId,
    cardProps = {},
  } = $props<{
    initialItems: FeedItem[];
    initialSort: Sort;
    initialCursor: string | null;
    sortOptions: readonly SortOption[];
    fetchUrl: (params: { sort: Sort; cursor: string | null }) => string;
    emptyMessage: string;
    supabase: SupabaseClient;
    userId: string;
    cardProps?: CardFlags;
  }>();

  let sort = $state<Sort>(untrack(() => initialSort));
  let items = $state<FeedItem[]>(untrack(() => initialItems));
  let cursor = $state<string | null>(untrack(() => initialCursor));
  let done = $state(untrack(() => initialCursor === null));

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

  async function onCopy(): Promise<void> {
    const ok = await copyText(ctxTargetText);
    showToast($_(ok ? "toastCopied" : "toastCopyFailed"));
  }

  async function onShare(): Promise<void> {
    if (navigator.share) {
      try {
        await navigator.share({ text: ctxTargetText });
      } catch {
        // user cancelled
      }
    } else {
      const ok = await copyText(ctxTargetText);
      showToast($_(ok ? "toastCopied" : "toastCopyFailed"));
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

  // SvelteKit re-runs the parent load on cookie writes / nav: resync the
  // paged state from the new props. `sort` is locally mutated by
  // onSortChange before the server roundtrip completes, so it stays
  // omitted here — let the explicit reset in onSortChange own that field.
  $effect(() => {
    items = initialItems;
    cursor = initialCursor;
    done = initialCursor === null;
  });

  $effect(() => {
    return installHighlightContextMenuListener({
      resolveText: (id) =>
        items.find((it) => it.highlight_id === id)?.text ?? null,
      onMenu: onHighlightMenu,
      onHide: () => {
        ctxVisible = false;
      },
    });
  });

  // AbortController replaces the prior fetchGen + inflight juggling:
  // a sort change aborts the in-flight scroll fetch so we don't burn
  // bandwidth or rate-limit budget on a result that gets discarded.
  // InfiniteScroll already guards against concurrent scroll triggers
  // via its own `loading` flag.
  let abortController: AbortController | null = null;

  async function onSortChange(next: Sort): Promise<void> {
    if (next === sort) return;
    writeSortCookie(next);
    sort = next;
    // Clear items atomically with cursor reset. If the replace fetch fails
    // and InfiniteScroll later fires a non-replace loadMore, the concat
    // would otherwise mix old-sort items with new-sort page 1 and produce
    // duplicate highlight_ids (Masonry idKey) → each_key_duplicate crash.
    items = [];
    cursor = null;
    done = false;
    await loadMore({ replace: true });
  }

  async function loadMore(opts: { replace?: boolean } = {}): Promise<void> {
    abortController?.abort();
    const ac = new AbortController();
    abortController = ac;
    try {
      const url = fetchUrl({
        sort,
        cursor: opts.replace ? null : cursor,
      });
      const res = await fetch(url, { signal: ac.signal });
      if (ac.signal.aborted) return;
      if (!res.ok) throw new Error(`feed fetch ${res.status}`);
      const payload = (await res.json()) as {
        items: FeedItem[];
        nextCursor: string | null;
      };
      if (ac.signal.aborted) return;
      items = opts.replace ? payload.items : [...items, ...payload.items];
      cursor = payload.nextCursor;
      if (!cursor || payload.items.length === 0) done = true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Replace-fetch failure: stop InfiniteScroll so it can't auto-retry
      // and append a successful page onto an empty/stale list. User has to
      // click a pill to retry, which clears state again via onSortChange.
      if (opts.replace) done = true;
      throw err;
    } finally {
      if (abortController === ac) abortController = null;
    }
  }
</script>

<SortPillRow options={sortOptions} active={sort} onChange={onSortChange} />

<div class="book-list">
  {#if items.length === 0}
    <div class="empty">{emptyMessage}</div>
  {:else}
    <Masonry
      {items}
      idKey="highlight_id"
      minColWidth={400}
      maxColWidth={680}
      gap={32}
      order="row-first"
    >
      {#snippet children({ item }: { item: (typeof items)[number] })}
        <HighlightCard
          {item}
          {supabase}
          {userId}
          {registerNoteEditor}
          {...cardProps}
        />
      {/snippet}
    </Masonry>
  {/if}
</div>

<InfiniteScroll {loadMore} hasMore={!done} />

<ContextMenu
  bind:visible={ctxVisible}
  x={ctxX}
  y={ctxY}
  targetId={ctxTargetId}
  hasNote={ctxHasNote}
  {onCopy}
  {onShare}
  {onDelete}
/>

<Toast bind:visible={toastVisible} message={toastMessage} />
