<script lang="ts">
  import "../app.css";
  import { invalidate, goto } from "$app/navigation";
  import { onMount } from "svelte";
  import Header from "$lib/components/Header.svelte";
  import MenuOverlay from "$lib/components/MenuOverlay.svelte";
  import { PRELOAD_FONTS } from "$lib/fonts";

  let { data, children } = $props();
  let menuOpen = $state(false);

  onMount(() => {
    const {
      data: { subscription },
    } = data.supabase.auth.onAuthStateChange((_, session) => {
      if (session?.expires_at !== data.session?.expires_at) {
        invalidate("supabase:auth");
      }
    });
    return () => subscription.unsubscribe();
  });

  async function logout(): Promise<void> {
    await data.supabase.auth.signOut();
    await invalidate("supabase:auth");
    goto("/auth/login");
  }
</script>

<svelte:head>
  {#each PRELOAD_FONTS as href (href)}
    <link
      rel="preload"
      {href}
      as="font"
      type="font/woff2"
      crossorigin="anonymous"
    />
  {/each}
</svelte:head>

<Header bind:menuOpen />
<MenuOverlay bind:open={menuOpen} onLogout={logout} />

{@render children()}

<footer class="site-footer">
  <a href="/privacy">Privacy</a>
</footer>

<style>
  .site-footer {
    padding: 1.5rem 1.25rem 2rem;
    text-align: center;
    font-size: 0.85rem;
    color: #9ca3af;
  }
  .site-footer a {
    color: inherit;
    text-decoration: underline;
  }
</style>
