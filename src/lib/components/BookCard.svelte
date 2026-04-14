<script lang="ts">
  import { _ } from "$lib/i18n";
  import type {
    LibraryBook,
    LibraryHighlight,
  } from "../../routes/app/+page.server";
  import HighlightBlock from "./HighlightBlock.svelte";
  import NoteEditor from "./NoteEditor.svelte";
  import type { SupabaseClient } from "@supabase/supabase-js";

  let {
    book,
    supabase,
    userId,
    onHighlightMenu,
    registerNoteEditor,
  } = $props<{
    book: LibraryBook;
    supabase: SupabaseClient;
    userId: string;
    onHighlightMenu: (payload: {
      x: number;
      y: number;
      highlightId: string;
      text: string;
      hasNote: boolean;
    }) => void;
    registerNoteEditor: (
      highlightId: string,
      handleDelete: () => Promise<void>,
    ) => void;
  }>();

  let expanded = $state(false);
  let container: HTMLDivElement | undefined = $state();

  function hasTextSelection(): boolean {
    const sel = window.getSelection();
    return !!sel && sel.toString().trim().length > 0;
  }

  function onCardClick(e: MouseEvent): void {
    if (e.button === 2) return;
    if (hasTextSelection()) return;
    const target = e.target as HTMLElement;
    if (target.closest("blockquote")) return;
    if (target.closest(".note-area")) return;
    if (expanded) collapse();
    else expand();
  }

  function expand(): void {
    expanded = true;
    queueMicrotask(() => {
      if (!container) return;
      container.style.transition = "max-height 0.35s ease";
      container.style.maxHeight = `${container.scrollHeight}px`;
      const onEnd = (): void => {
        container?.removeEventListener("transitionend", onEnd);
        if (expanded && container) container.style.maxHeight = "none";
      };
      container.addEventListener("transitionend", onEnd);
    });
  }

  function collapse(): void {
    if (!container) return;
    container.style.maxHeight = `${container.scrollHeight}px`;
    // force reflow so the browser registers the starting value
    void container.offsetHeight;
    container.style.maxHeight = "0";
    expanded = false;
  }

  async function saveNote(highlightId: string, text: string): Promise<void> {
    if (text.trim().length === 0) {
      await removeNote(highlightId);
      return;
    }
    const { error } = await supabase
      .from("notes")
      .upsert(
        { highlight_id: highlightId, user_id: userId, text },
        { onConflict: "highlight_id" },
      );
    if (error) throw error;
  }

  async function removeNote(highlightId: string): Promise<void> {
    const { error } = await supabase
      .from("notes")
      .delete()
      .eq("highlight_id", highlightId);
    if (error) throw error;
  }

  type ChapterGroup = {
    title: string | null;
    highlights: LibraryHighlight[];
  };

  let groups = $derived<ChapterGroup[]>(groupByChapter(book.highlights ?? []));

  function groupByChapter(hls: LibraryHighlight[]): ChapterGroup[] {
    const out: ChapterGroup[] = [];
    let current: ChapterGroup | null = null;
    for (const hl of hls) {
      const title = hl.chapter_title ?? null;
      if (!current || current.title !== title) {
        current = { title, highlights: [] };
        out.push(current);
      }
      current.highlights.push(hl);
    }
    return out;
  }

  const initial = $derived(book.title?.trim().charAt(0).toUpperCase() || "?");
  const count = $derived(book.highlights?.length ?? 0);
</script>

<div
  class="book-card"
  class:expanded
  role="button"
  tabindex="0"
  onclick={onCardClick}
  onkeydown={(e) => {
    if (e.key === "Enter") onCardClick(e as unknown as MouseEvent);
  }}
>
  <div class="book-header">
    <div class="book-cover book-cover-placeholder" aria-hidden="true">
      {initial}
    </div>
    <div class="book-info">
      <div class="book-title" dir="auto">
        {book.title || $_("untitled")}
      </div>
      <div class="book-author" dir="auto">
        {book.author || $_("unknownAuthor")}
      </div>
      <div class="book-meta">
        {$_("highlightCount", { values: { count } })}
      </div>
    </div>
  </div>

  <div bind:this={container} class="highlights-container">
    {#if expanded}
      {#if groups.length === 0}
        <div class="loading">{$_("noHighlightsInBook")}</div>
      {:else}
        {#each groups as group, gi (gi)}
          {#if group.title}
            <div class="chapter-heading" dir="auto">{group.title}</div>
          {/if}
          {#each group.highlights as hl (hl.id)}
            <HighlightBlock
              highlight={{
                id: hl.id,
                text: hl.text,
                styles: hl.styles,
              }}
              onMenu={({ x, y, id }) =>
                onHighlightMenu({
                  x,
                  y,
                  highlightId: id,
                  text: hl.text,
                  hasNote: !!hl.note_text,
                })}
            />
            <NoteEditor
              highlightId={hl.id}
              initialText={hl.note_text}
              initialUpdatedAt={hl.note_updated_at}
              save={(t) => saveNote(hl.id, t)}
              remove={() => removeNote(hl.id)}
              onReady={(api) => registerNoteEditor(hl.id, api.handleDelete)}
            />
          {/each}
        {/each}
      {/if}
    {/if}
  </div>
</div>

<style>
  .book-cover-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #e8e8e8;
    font-family: "JetBrains Mono", monospace;
    font-weight: 500;
    font-size: 2rem;
    background: #2a2a2a;
  }
</style>
