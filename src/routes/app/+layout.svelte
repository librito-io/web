<script lang="ts">
  import { goto, invalidate } from "$app/navigation";
  import { onMount } from "svelte";
  import OverlayMenu from "$lib/components/OverlayMenu.svelte";

  let { data, children } = $props();
  let menuOpen = $state(false);
  let scrolled = $state(false);
  let sentinel: HTMLElement;

  onMount(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        scrolled = !entry.isIntersecting;
      },
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  });

  async function handleLogout() {
    await data.supabase.auth.signOut();
    await invalidate("supabase:auth");
    goto("/auth/login");
  }
</script>

<div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>

<header class="page-header" class:scrolled>
  <button
    class="menu-btn"
    onclick={() => (menuOpen = true)}
    aria-label="Open menu">≡</button
  >
  <span class="brand">librito</span>
</header>

<OverlayMenu bind:open={menuOpen} onLogout={handleLogout} />

<main>
  {@render children()}
</main>

<style>
  .sentinel {
    height: 1px;
    width: 1px;
  }
  .page-header {
    position: sticky;
    top: 0;
    z-index: 800;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    background: var(--bg);
    border-bottom: 1px solid transparent;
    transition: border-color 120ms ease-out;
  }
  .page-header.scrolled {
    border-bottom-color: var(--border);
  }
  .menu-btn {
    font-size: 1.5rem;
    padding: 4px 8px;
  }
  .brand {
    font-family: var(--font-mono);
    font-weight: 500;
    font-size: 1.05rem;
    letter-spacing: 0.02em;
  }
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 24px 20px 96px;
  }
</style>
