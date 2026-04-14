<script lang="ts">
  import { _ } from "$lib/i18n";
  import HighlightBlock from "$lib/components/HighlightBlock.svelte";
  import NoteEditor from "$lib/components/NoteEditor.svelte";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import Toast from "$lib/components/Toast.svelte";

  let { data } = $props();

  type Highlight = (typeof data)["highlights"][number];

  let highlights = $state<Highlight[]>(data.highlights);
  let toast = $state<string | null>(null);

  let menuVisible = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuHighlightId = $state<string | null>(null);

  const menuHighlight = $derived(
    highlights.find((h) => h.id === menuHighlightId) ?? null,
  );

  const grouped = $derived.by(() => {
    const out: { chapter: string | null; items: Highlight[] }[] = [];
    let current: { chapter: string | null; items: Highlight[] } | null = null;
    for (const h of highlights) {
      if (!current || current.chapter !== (h.chapter_title ?? null)) {
        current = { chapter: h.chapter_title ?? null, items: [] };
        out.push(current);
      }
      current.items.push(h);
    }
    return out;
  });

  async function saveNote(id: string, text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      const { error } = await data.supabase
        .from("notes")
        .delete()
        .eq("highlight_id", id);
      if (error) throw error;
      updateNote(id, null);
      return;
    }
    const { error } = await data.supabase
      .from("notes")
      .upsert(
        { highlight_id: id, text: trimmed, user_id: data.user!.id },
        { onConflict: "highlight_id" },
      );
    if (error) throw error;
    updateNote(id, trimmed);
  }

  async function deleteNote(id: string) {
    const { error } = await data.supabase
      .from("notes")
      .delete()
      .eq("highlight_id", id);
    if (error) throw error;
    updateNote(id, null);
    toast = $_("ctx.noteDeleted");
  }

  function updateNote(id: string, text: string | null): void {
    const h = highlights.find((x) => x.id === id);
    if (!h) return;
    h.note_text = text;
    h.note_updated_at = text ? new Date().toISOString() : null;
  }

  function openMenu({ x, y, id }: { x: number; y: number; id: string }) {
    menuX = x;
    menuY = y;
    menuHighlightId = id;
    menuVisible = true;
  }

  async function copyTargetText() {
    if (!menuHighlight) return;
    try {
      await navigator.clipboard.writeText(menuHighlight.text);
      toast = $_("ctx.copied");
    } catch {
      // Clipboard denied (unlikely in same-origin HTTPS auth context).
      toast = $_("common.error");
    }
  }

  async function shareTarget() {
    if (!menuHighlight) return;
    const text = menuHighlight.text;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text });
        return;
      } catch {
        // User cancelled or share failed — fall back to copy.
      }
    }
    await copyTargetText();
  }
</script>

<nav class="breadcrumb">
  <a href="/app">← {$_("book.back")}</a>
</nav>

<header class="book-head">
  <h1>{data.book.title ?? "Untitled"}</h1>
  {#if data.book.author}
    <p class="author">{data.book.author}</p>
  {/if}
</header>

{#if highlights.length === 0}
  <p class="empty">{$_("book.empty")}</p>
{:else}
  {#each grouped as group, i (i)}
    {#if group.chapter}
      <h2 class="chapter">{group.chapter}</h2>
    {/if}
    {#each group.items as h (h.id)}
      <HighlightBlock highlight={h} onMenu={openMenu} />
      <NoteEditor
        highlightId={h.id}
        initialText={h.note_text}
        initialUpdatedAt={h.note_updated_at}
        save={(t) => saveNote(h.id, t)}
        remove={() => deleteNote(h.id)}
      />
    {/each}
  {/each}
{/if}

<ContextMenu
  bind:visible={menuVisible}
  x={menuX}
  y={menuY}
  hasNote={!!menuHighlight?.note_text}
  onCopy={copyTargetText}
  onShare={shareTarget}
  onDelete={() => menuHighlightId && deleteNote(menuHighlightId)}
/>

<Toast bind:message={toast} />

<style>
  .breadcrumb {
    margin-bottom: 16px;
  }
  .breadcrumb a {
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  .book-head {
    margin-bottom: 28px;
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 600;
  }
  .author {
    color: var(--text-secondary);
    margin-top: 4px;
  }
  .chapter {
    font-size: 1rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin: 28px 0 12px;
    letter-spacing: 0.02em;
  }
  .empty {
    padding: 40px 0;
    text-align: center;
    color: var(--text-secondary);
  }
</style>
