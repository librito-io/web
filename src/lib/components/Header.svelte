<script lang="ts">
  import { _ } from "$lib/i18n";
  import LanguageDropdown from "./LanguageDropdown.svelte";

  let { menuOpen = $bindable<boolean>(false) } = $props<{
    menuOpen: boolean;
  }>();
</script>

<header class="site-header">
  <div class="header-inner">
    <h1>Librito</h1>
    <div class="header-actions">
      <LanguageDropdown />
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
    </div>
  </div>
</header>

<style>
  /* Site-header chrome. Scoped to this component (Svelte hashes the
     selector) so the sticky positioning + z-index physically cannot match
     any other <header> in the app. Keeping layout off a globally-reachable
     selector is the rule that prevents the book-detail menu-overlay
     stacking regression class. Typography (.site-header h1) + .header-inner
     layout stay centralized in app.css per the type convention (#421). */
  .site-header {
    background: #0a0c0f;
    position: sticky;
    top: 0;
    z-index: 60;
    border-bottom: 1px solid #232629;
  }
</style>
