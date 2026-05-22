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
  .bold {
    font-weight: 700;
  }
  .italic {
    font-style: italic;
  }
</style>
