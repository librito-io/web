<script lang="ts">
  import "../app.css";
  import { invalidate, goto, beforeNavigate } from "$app/navigation";
  import { updated } from "$app/state";
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

  // After a deploy, pages kept open reference chunk URLs from the
  // previous build. The version poll configured in svelte.config.js
  // flips `updated.current` to true on mismatch; here we force a full
  // page navigation so the browser fetches the new chunk graph fresh
  // instead of letting client-side routing lazy-import old chunks that
  // may already have rotated on the Vercel alias. Without this hook,
  // the residual symptom is Safari "Importing a module script failed"
  // (issue #413, Sentry LIBRITO-WEB-C). `willUnload` skips browser-
  // initiated full unloads; missing `to.url` means a non-navigable
  // target (external/anchor edge cases).
  beforeNavigate(({ willUnload, to }) => {
    if (updated.current && !willUnload && to?.url) {
      location.href = to.url.href;
    }
  });

  onMount(() => {
    // Hydration probe for the Playwright e2e suite. SSR ships interactive
    // buttons without onclick handlers; a click racing hydration silently
    // no-ops. Tests `awaitHydration(page)` on `html[data-hydrated]` instead
    // of the discouraged `waitForLoadState("networkidle")` — long-lived
    // Realtime / SSE / analytics requests keep the network non-idle and
    // would time out unrelated to product behaviour. See issue #360.
    document.documentElement.setAttribute("data-hydrated", "true");

    // Block pinch-zoom on iOS Safari. The viewport meta's user-scalable=no
    // is honored by Android Chrome but ignored by iOS Safari ≥10 for a11y.
    // OS-level Accessibility Zoom still works regardless.
    const blockGesture = (e: Event): void => e.preventDefault();
    const blockMultiTouch = (e: TouchEvent): void => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener("gesturestart", blockGesture);
    document.addEventListener("gesturechange", blockGesture);
    document.addEventListener("gestureend", blockGesture);
    document.addEventListener("touchmove", blockMultiTouch, { passive: false });

    // Recover from stale-chunk dynamic-import failures across a deploy.
    // After a Vercel deploy, a page kept open references chunk URLs from
    // the previous build; the production alias now points at the new
    // deploy and the old chunks have rotated away. Vite fires
    // `vite:preloadError` whenever its preload helper fails to import a
    // chunk — covering BOTH route navigations and same-page lazy imports,
    // the residual the version poll (svelte.config.js) + `beforeNavigate`
    // hard-reload above cannot catch (same-page imports fire no nav; any
    // import between 5-min poll ticks is unguarded). A one-shot reload
    // (throttled via sessionStorage) fetches the new chunk graph fresh.
    //
    // Do NOT preventDefault: Vite's __vitePreload does
    // `baseModule().catch(handlePreloadError)`, so preventing the re-throw
    // makes the failed import RESOLVE to `undefined` instead of rejecting.
    // Consumers then read `.default` off undefined and throw a confusing
    // downstream TypeError (svelte-i18n runtime.js:131 `partial.default` —
    // Sentry LIBRITO-WEB-M). Letting Vite throw keeps the import a clean
    // rejection; the benign stale-chunk message that surfaces in the brief
    // pre-reload window is dropped by the message-keyed beforeSend filter
    // in hooks.client.ts (isStaleModuleImportNoise). Issue #413, Sentry
    // LIBRITO-WEB-C.
    const onPreloadError = (): void => {
      const KEY = "vite-preload-reload-ts";
      const last = Number(sessionStorage.getItem(KEY) ?? "0");
      if (Date.now() - last < 10_000) return; // already retried → let it surface
      sessionStorage.setItem(KEY, String(Date.now()));
      location.reload();
    };
    window.addEventListener("vite:preloadError", onPreloadError);

    const {
      data: { subscription },
    } = data.supabase.auth.onAuthStateChange((_, session) => {
      if (session?.expires_at !== data.session?.expires_at) {
        invalidate("supabase:auth");
      }
    });
    return () => {
      subscription.unsubscribe();
      document.removeEventListener("gesturestart", blockGesture);
      document.removeEventListener("gesturechange", blockGesture);
      document.removeEventListener("gestureend", blockGesture);
      document.removeEventListener("touchmove", blockMultiTouch);
      window.removeEventListener("vite:preloadError", onPreloadError);
    };
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
