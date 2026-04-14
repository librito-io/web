<script lang="ts">
  import "../app.css";
  import { invalidate, goto } from "$app/navigation";
  import { onMount } from "svelte";
  import Header from "$lib/components/Header.svelte";
  import MenuOverlay from "$lib/components/MenuOverlay.svelte";

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

<Header bind:menuOpen />
<MenuOverlay bind:open={menuOpen} onLogout={logout} />

{@render children()}
