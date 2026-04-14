<script lang="ts">
  import { goto, invalidate } from "$app/navigation";

  let { data, children } = $props();

  async function handleLogout() {
    await data.supabase.auth.signOut();
    await invalidate("supabase:auth");
    goto("/auth/login");
  }
</script>

<nav>
  <a href="/app">Dashboard</a>
  <a href="/app/devices">Devices</a>
  <button onclick={handleLogout}>Log out</button>
</nav>

<main>
  {@render children()}
</main>
