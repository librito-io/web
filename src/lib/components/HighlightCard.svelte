<script lang="ts">
  import { _ } from "$lib/i18n";
  import type { FeedRow } from "$lib/feed/types";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import HighlightBlock from "./HighlightBlock.svelte";
  import NoteEditor from "./NoteEditor.svelte";

  let {
    row,
    supabase,
    userId,
    onHighlightMenu,
    registerNoteEditor,
    showChapterHeading = true,
    showHighlightCount = true,
    linkBookText = true,
  } = $props<{
    row: FeedRow;
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
    showChapterHeading?: boolean;
    showHighlightCount?: boolean;
    linkBookText?: boolean;
  }>();

  const bookHref = $derived(`/app/book/${encodeURIComponent(row.book_hash)}`);
  const initial = $derived(
    row.book_title?.trim().charAt(0).toUpperCase() || "?",
  );

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
    row.note_text = text;
    row.note_updated_at = new Date().toISOString();
  }

  async function removeNote(highlightId: string): Promise<void> {
    const { error } = await supabase
      .from("notes")
      .delete()
      .eq("highlight_id", highlightId);
    if (error) throw error;
    row.note_text = null;
    row.note_updated_at = null;
  }
</script>

<div class="book-card expanded">
  <div class="book-header">
    <a
      href={bookHref}
      class="book-cover book-cover-placeholder"
      aria-hidden="true"
    >
      {initial}
    </a>
    <div class="book-info">
      {#if linkBookText}
        <a href={bookHref} class="book-title book-link" dir="auto">
          {row.book_title || $_("untitled")}
        </a>
        <a href={bookHref} class="book-author book-link" dir="auto">
          {row.book_author || $_("unknownAuthor")}
        </a>
      {:else}
        <div class="book-title" dir="auto">
          {row.book_title || $_("untitled")}
        </div>
        <div class="book-author" dir="auto">
          {row.book_author || $_("unknownAuthor")}
        </div>
      {/if}
      {#if showHighlightCount}
        <a href={bookHref} class="book-meta book-link">
          {$_("highlightCount", {
            values: { count: row.book_highlight_count },
          })}
        </a>
      {/if}
    </div>
  </div>

  <div class="highlights-container">
    {#if showChapterHeading && row.chapter_title}
      <div class="chapter-heading" dir="auto">{row.chapter_title}</div>
    {/if}
    <HighlightBlock
      highlight={{
        id: row.highlight_id,
        text: row.text,
        styles: row.styles,
      }}
      onMenu={({ x, y, id }) =>
        onHighlightMenu({
          x,
          y,
          highlightId: id,
          text: row.text,
          hasNote: !!row.note_text,
        })}
    />
    <NoteEditor
      highlightId={row.highlight_id}
      initialText={row.note_text}
      initialUpdatedAt={row.note_updated_at}
      save={(t) => saveNote(row.highlight_id, t)}
      remove={() => removeNote(row.highlight_id)}
      onReady={(api) => registerNoteEditor(row.highlight_id, api.handleDelete)}
    />
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
    text-decoration: none;
  }
  .book-link {
    display: block;
    text-decoration: none;
    color: inherit;
  }
  .book-link:hover {
    text-decoration: underline;
  }
</style>
