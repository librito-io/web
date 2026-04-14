<script lang="ts">
  import { renderStyledText, type StyledRun } from "$lib/rendering/styledText";

  type HighlightInput = {
    id: string;
    text: string;
    styles: string | null;
  };

  let { highlight, onMenu } = $props<{
    highlight: HighlightInput;
    onMenu: (payload: { x: number; y: number; id: string }) => void;
  }>();

  let runs = $derived<StyledRun[]>(
    renderStyledText(highlight.text, highlight.styles),
  );

  function openMenu(e: MouseEvent, preventDefault: boolean): void {
    if (preventDefault) e.preventDefault();
    e.stopPropagation();
    onMenu({ x: e.clientX, y: e.clientY, id: highlight.id });
  }
</script>

<blockquote dir="auto" oncontextmenu={(e) => openMenu(e, true)}>
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
  <button
    class="more"
    onclick={(e) => openMenu(e, false)}
    aria-label="More actions">⋯</button
  >
</blockquote>

<style>
  blockquote {
    position: relative;
    background: var(--highlight-bg);
    color: var(--highlight-text);
    padding: 18px 44px 18px 20px;
    border-radius: var(--radius-md);
    font-family: var(--font-serif);
    font-size: 1.05rem;
    line-height: 1.6;
    white-space: pre-wrap;
  }
  .bold {
    font-weight: 700;
  }
  .italic {
    font-style: italic;
  }
  .more {
    position: absolute;
    top: 6px;
    right: 8px;
    padding: 4px 10px;
    font-size: 1.2rem;
    color: var(--highlight-text);
    opacity: 0;
    transition: opacity 120ms;
  }
  blockquote:hover .more,
  .more:focus-visible {
    opacity: 0.7;
  }
  .more:hover {
    opacity: 1;
  }
</style>
