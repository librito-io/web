<script lang="ts">
  import { _ } from "$lib/i18n";
  import LanguageDropdown from "./LanguageDropdown.svelte";

  let { menuOpen = $bindable<boolean>(false) } = $props<{
    menuOpen: boolean;
  }>();
</script>

<header>
  <div class="header-inner">
    <h1>Librito</h1>
    <div style="display: flex; align-items: center; gap: 16px">
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
