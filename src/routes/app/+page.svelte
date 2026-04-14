<script lang="ts">
  import { _ } from "$lib/i18n";
  import BookCard from "$lib/components/BookCard.svelte";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import Toast from "$lib/components/Toast.svelte";

  let { data } = $props();

  const books = $derived(data.books);
  const totalHighlights = $derived(
    books.reduce(
      (sum: number, b: (typeof books)[number]) =>
        sum + (b.highlights?.length ?? 0),
      0,
    ),
  );

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
        // user cancelled — silent
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
</script>

<div class="content">
  <div class="page-header">
    <h2>{$_("highlights")}</h2>
    <div class="page-subtitle">
      {$_("subtitle", {
        values: { count: books.length, highlights: totalHighlights },
      })}
    </div>
  </div>

  <div class="book-list">
    {#if books.length === 0}
      <div class="empty">{$_("noHighlights")}</div>
    {:else}
      {#each books as book (book.id)}
        <BookCard
          {book}
          supabase={data.supabase}
          userId={data.user?.id ?? ""}
          {onHighlightMenu}
          {registerNoteEditor}
        />
      {/each}
    {/if}
  </div>
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
