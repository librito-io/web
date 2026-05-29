<script lang="ts">
  import { renderStyledText, type StyledRun } from "$lib/rendering/styledText";

  type HighlightInput = {
    id: string;
    text: string;
    styles: string | null;
  };

  let { highlight, hasNote } = $props<{
    highlight: HighlightInput;
    hasNote: boolean;
  }>();

  let runs = $derived<StyledRun[]>(
    renderStyledText(highlight.text, highlight.styles),
  );
</script>

<blockquote
  dir="auto"
  data-highlight-id={highlight.id}
  data-has-note={hasNote ? "true" : "false"}
>
  {#each runs as run, i (i)}
    {#if run.isBreak}
      <br /><br />
    {:else if run.bold}
      <span class="bold">{run.text}</span>
    {:else if run.italic}
      <span class="italic">{run.text}</span>
    {:else}
      <span>{run.text}</span>
    {/if}
  {/each}
</blockquote>

<style>
  /* Highlight text sits above the card-link overlay (.card-link is
     position:absolute; z-index:1 in HighlightCard) so selection + the
     context menu hit the text, not the link. Scoped here — NOT a bare
     `blockquote` rule in app.css — so this positioning cannot leak onto
     other semantic <blockquote> elements (issue #472). Typography for the
     blockquote stays centralized in app.css per #421. */
  blockquote {
    position: relative;
    z-index: 2;
  }
  .bold {
    font-weight: 700;
  }
  .italic {
    font-style: italic;
  }
</style>
