<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>Privacy · Librito</title>
</svelte:head>

<article class="prose">
  {@html data.html}
</article>

<style>
  .prose {
    max-width: 42rem;
    margin: 2rem auto;
    padding: 0 1.25rem;
    line-height: 1.6;
    color: #1f2937;
  }
  .prose :global(h1) {
    font-size: 1.75rem;
    margin-bottom: 1rem;
  }
  .prose :global(h2) {
    font-size: 1.25rem;
    margin-top: 2rem;
    margin-bottom: 0.75rem;
  }
  .prose :global(p),
  .prose :global(ul) {
    margin-bottom: 0.75rem;
  }
  .prose :global(ul) {
    padding-left: 1.25rem;
  }
</style>
