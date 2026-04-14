<script lang="ts">
  import { onMount } from "svelte";

  let { children } = $props();

  onMount(() => {
    const siteHeader = document.querySelector("header");
    if (!siteHeader) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        const pageHeader = document.querySelector(".page-header");
        pageHeader?.classList.toggle("has-line", !entry.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(siteHeader);
    return () => io.disconnect();
  });
</script>

{@render children()}
