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
    registerNoteEditor,
    showChapterHeading = true,
    linkBookText = true,
  } = $props<{
    item: FeedItem;
    supabase: SupabaseClient;
    userId: string;
    registerNoteEditor: (
      highlightId: string,
      handleDelete: () => Promise<void>,
    ) => void;
    showChapterHeading?: boolean;
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
  {#if linkBookText}
    <a
      href={bookHref}
      class="card-link"
      aria-label={item.book_title || $_("untitled")}
    ></a>
  {/if}
  <div class="book-header">
    {#if item.coverUrl}
      <img
        class="book-cover"
        src={item.coverUrl}
        alt=""
        width="80"
        height="120"
        loading="lazy"
      />
    {:else}
      <div class="book-cover book-cover-placeholder" aria-hidden="true">
        {initial}
      </div>
    {/if}
    <div class="book-info">
      <div class="book-title" dir="auto">
        {item.book_title || $_("untitled")}
      </div>
      <div class="book-author" dir="auto">
        {item.book_author || $_("unknownAuthor")}
      </div>
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
      hasNote={!!noteText}
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
    color: #dedede;
    /* Inherits the body Inter stack (like .book-title). Single centered
       glyph, so letter-spacing is moot. */
    font-weight: 600;
    font-size: 2rem;
    background: #2a2a2a;
    text-decoration: none;
  }
  .card-link {
    position: absolute;
    inset: 0;
    z-index: 1;
    border-radius: inherit;
    text-decoration: none;
    /* Suppress the iOS long-press callout so the whole-card link taps to
       navigate like a native row, with no "Open in New Tab" popup. Also block
       the drag-and-drop lift callout:none otherwise falls through to — that
       lift paints a rounded drag-preview over the card and visually erased the
       1px border on long-press. */
    -webkit-touch-callout: none;
    -webkit-user-drag: none;
    user-select: none;
  }
  .card-link:focus-visible {
    outline: 2px solid #2883de;
    outline-offset: 2px;
  }
</style>
