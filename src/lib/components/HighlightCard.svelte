<script lang="ts">
  import { _ } from "$lib/i18n";
  import type { FeedItem } from "$lib/feed/types";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import HighlightBlock from "./HighlightBlock.svelte";
  import NoteEditor from "./NoteEditor.svelte";

  let {
    item,
    supabase,
    userId,
    onHighlightMenu,
    registerNoteEditor,
    showChapterHeading = true,
    showHighlightCount = true,
    linkBookText = true,
  } = $props<{
    item: FeedItem;
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

  const bookHref = $derived(`/app/book/${encodeURIComponent(item.book_hash)}`);
  const initial = $derived(
    item.book_title?.trim().charAt(0).toUpperCase() || "?",
  );

  let noteOverride = $state<{
    text: string | null;
    updatedAt: string | null;
  } | null>(null);
  const noteText = $derived(noteOverride ? noteOverride.text : item.note_text);
  const noteUpdatedAt = $derived(
    noteOverride ? noteOverride.updatedAt : item.note_updated_at,
  );

  async function saveNote(highlightId: string, text: string): Promise<void> {
    if (text.trim().length === 0) {
      await removeNote(highlightId);
      return;
    }
    // deleted_at: null clears any existing tombstone so saving a note on a
    // previously-trashed highlight resurrects the row instead of writing
    // text to a soft-deleted ghost (RPCs + sync would hide it on refresh).
    const { error } = await supabase
      .from("notes")
      .upsert(
        { highlight_id: highlightId, user_id: userId, text, deleted_at: null },
        { onConflict: "highlight_id" },
      );
    if (error) throw error;
    noteOverride = { text, updatedAt: new Date().toISOString() };
  }

  async function removeNote(highlightId: string): Promise<void> {
    const { error } = await supabase
      .from("notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("highlight_id", highlightId)
      .eq("user_id", userId)
      .is("deleted_at", null);
    if (error) throw error;
    noteOverride = { text: null, updatedAt: null };
  }
</script>

<div class="book-card expanded">
  <div class="book-header">
    {#if linkBookText}
      <a href={bookHref} class="book-cover-link" aria-hidden="true">
        {#if item.coverUrl}
          <img
            class="book-cover"
            src={item.coverUrl}
            alt=""
            width="67"
            height="100"
            loading="lazy"
          />
        {:else}
          <div class="book-cover book-cover-placeholder">
            {initial}
          </div>
        {/if}
      </a>
    {:else if item.coverUrl}
      <img
        class="book-cover"
        src={item.coverUrl}
        alt=""
        width="67"
        height="100"
        loading="lazy"
      />
    {:else}
      <div class="book-cover book-cover-placeholder" aria-hidden="true">
        {initial}
      </div>
    {/if}
    <div class="book-info">
      {#if linkBookText}
        <a href={bookHref} class="book-title book-link" dir="auto">
          {item.book_title || $_("untitled")}
        </a>
        <a href={bookHref} class="book-author book-link" dir="auto">
          {item.book_author || $_("unknownAuthor")}
        </a>
      {:else}
        <div class="book-title" dir="auto">
          {item.book_title || $_("untitled")}
        </div>
        <div class="book-author" dir="auto">
          {item.book_author || $_("unknownAuthor")}
        </div>
      {/if}
      {#if showHighlightCount}
        <a href={bookHref} class="book-meta book-link">
          {$_("highlightCount", {
            values: { count: item.book_highlight_count },
          })}
        </a>
      {/if}
    </div>
  </div>

  <div class="highlights-container">
    {#if showChapterHeading && item.chapter_title}
      <div class="chapter-heading" dir="auto">{item.chapter_title}</div>
    {/if}
    <HighlightBlock
      highlight={{
        id: item.highlight_id,
        text: item.text,
        styles: item.styles,
      }}
      onMenu={({ x, y, id }) =>
        onHighlightMenu({
          x,
          y,
          highlightId: id,
          text: item.text,
          hasNote: !!noteText,
        })}
    />
    <NoteEditor
      highlightId={item.highlight_id}
      initialText={noteText}
      initialUpdatedAt={noteUpdatedAt}
      save={(t) => saveNote(item.highlight_id, t)}
      remove={() => removeNote(item.highlight_id)}
      onReady={(api) => registerNoteEditor(item.highlight_id, api.handleDelete)}
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
