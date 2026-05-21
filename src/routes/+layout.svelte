<script lang="ts">
  import "../app.css";
  import { invalidate, goto } from "$app/navigation";
  import { onMount } from "svelte";
  import * as Sentry from "@sentry/sveltekit";
  import Header from "$lib/components/Header.svelte";
  import MenuOverlay from "$lib/components/MenuOverlay.svelte";
  import { PRELOAD_FONTS } from "$lib/fonts";

  let { data, children } = $props();
  let menuOpen = $state(false);

  // Tag Sentry events with the Supabase user ID so client-side errors
  // can be correlated with the user that hit them. ID only — NEVER
  // email — per the privacy posture (sendDefaultPii: false in
  // hooks.client.ts). data.user mirrors the { session, user } shape
  // from safeGetSession() in hooks.server.ts. Sentry.setUser is a no-op
  // when the SDK was not initialized (self-hosters without
  // PUBLIC_SENTRY_DSN), so this is safe to call unconditionally.
  $effect(() => {
    if (data.user?.id) {
      Sentry.setUser({ id: data.user.id });
    } else {
      Sentry.setUser(null);
    }
  });

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
