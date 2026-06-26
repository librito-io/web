<script lang="ts">
  import { _ } from "$lib/i18n";
  import { page } from "$app/state";
  import LanguageDropdown from "./LanguageDropdown.svelte";

  let { menuOpen = $bindable<boolean>(false), loggedIn = false } = $props<{
    menuOpen: boolean;
    loggedIn?: boolean;
  }>();

  // Logo links home everywhere except the homepage itself, where the link
  // would be a no-op (and the bare wordmark reads cleaner).
  const onHome = $derived(page.url.pathname === "/");
</script>

<header class="site-header">
  <div class="header-inner">
    <h1>
      {#if onHome}
        <img class="logo" src="/librito.svg" alt="Librito" />
      {:else}
        <a class="logo-link" href="/">
          <img class="logo" src="/librito.svg" alt="Librito" />
        </a>
      {/if}
    </h1>
    <div class="header-actions">
      <LanguageDropdown />
      <!-- App chrome is gated on auth (issue #553): logged-out visitors must
           not see the overlay menu, which leaks the product's structure
           pre-launch. The hamburger is replaced by a Log-in link in the same
           right-slot so existing users still have a way in; the MenuOverlay is
           not rendered at all (see +layout.svelte). -->
      {#if loggedIn}
        <div class="menu-wrap">
          <button
            class="menu-btn"
            class:open={menuOpen}
            aria-label={$_("menuLabel")}
            onclick={(e) => {
              e.stopPropagation();
              menuOpen = !menuOpen;
            }}
          >
            <div class="menu-icon">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </button>
        </div>
      {:else}
        <a class="login-link" href="/auth/login">{$_("navLogIn")}</a>
      {/if}
    </div>
  </div>
</header>

<style>
  /* Site-header chrome. Scoped to this component (Svelte hashes the
     selector) so the sticky positioning + z-index physically cannot match
     any other <header> in the app. Layout on a globally-reachable selector
     is how the book-detail menu-overlay stacking bug happened (#473) —
     scoping prevents that category of regression. Typography (.site-header
     h1) + .header-inner layout stay centralized in app.css per the type
     convention (#421). */
  .site-header {
    background: #0a0c0f;
    position: sticky;
    top: 0;
    z-index: 60;
    border-bottom: 1px solid #232629;
  }
  /* Wordmark replaces the text title. Height-locked to the old ~18px h1
     cap line; width follows the SVG's 3.57:1 aspect. display:block kills
     the inline-image baseline gap so it vertical-centers in .header-inner. */
  .logo {
    display: block;
    height: 20px;
    width: auto;
  }
  .logo-link {
    /* Block-level flex (not inline-flex): an inline-level wrapper gives the
       h1 a line box whose line-height + baseline alignment shifts the
       wordmark up vs the homepage's bare block <img>. flex collapses the h1
       to the 20px image height, matching both pages. */
    display: flex;
  }
  /* Same "lift toward light" as the auth buttons + page logo (#dedede →
     #fff). Only when the wordmark is a link (not on the homepage). */
  .logo-link .logo {
    transition: filter var(--dur-2) var(--ease-hover);
  }
  .logo-link:hover .logo {
    filter: brightness(1.15);
  }
</style>
