<script lang="ts">
  import { _ } from "$lib/i18n";
  import LanguageDropdown from "./LanguageDropdown.svelte";

  let { menuOpen = $bindable<boolean>(false), loggedIn = false } = $props<{
    menuOpen: boolean;
    loggedIn?: boolean;
  }>();
</script>

<header class="site-header">
  <div class="header-inner">
    <h1>Librito</h1>
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
</style>
