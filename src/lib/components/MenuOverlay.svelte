<script lang="ts">
  import { _ } from "$lib/i18n";

  let { open = $bindable<boolean>(false), onLogout } = $props<{
    open: boolean;
    onLogout: () => void | Promise<void>;
  }>();

  let overlayEl: HTMLDivElement | undefined = $state();
  let savedScrollY = 0;

  function applyStagger(visible: boolean): void {
    if (!overlayEl) return;
    const items = overlayEl.querySelectorAll<HTMLElement>(
      ".menu-primary-item, .menu-divider, .menu-secondary a",
    );
    items.forEach((el, i) => {
      el.style.transitionDelay = visible ? `${200 + i * 20}ms` : "0ms";
    });
  }

  function lockScroll(): void {
    savedScrollY = window.scrollY;
    document.body.style.position = "fixed";
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.width = "100%";
  }

  function unlockScroll(): void {
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, savedScrollY);
  }

  $effect(() => {
    if (!overlayEl) return;
    const header = document.querySelector("header") as HTMLElement | null;
    const headerH = header?.offsetHeight ?? 0;
    overlayEl.style.top = `${headerH}px`;

    if (open) {
      overlayEl.style.height = `${window.innerHeight - headerH}px`;
      lockScroll();
    } else {
      overlayEl.style.height = "0";
      unlockScroll();
    }
    applyStagger(open);
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) open = false;
  }

  async function handleLogout(): Promise<void> {
    open = false;
    await onLogout();
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  bind:this={overlayEl}
  class="menu-overlay"
  class:visible={open}
  id="menuOverlay"
>
  <div class="menu-overlay-content">
    <div class="menu-primary">
      <a href="/app" class="menu-primary-item" onclick={() => (open = false)}>
        {$_("menuHighlightManager")}
      </a>
      <a href="#" class="menu-primary-item" onclick={() => (open = false)}>
        {$_("menuBookTransfer")}
      </a>
      <a
        href="/app/devices"
        class="menu-primary-item"
        onclick={() => (open = false)}
      >
        {$_("menuDevices")}
      </a>
    </div>
    <div class="menu-divider"></div>
    <div class="menu-secondary">
      <a href="#" onclick={() => (open = false)}>{$_("menuHelp")}</a>
      <a href="#" onclick={() => (open = false)}>{$_("menuDiscord")}</a>
      <a href="#" onclick={() => (open = false)}>{$_("menuAbout")}</a>
      <a href="#" onclick={() => (open = false)}>{$_("menuGithub")}</a>
      <a href="#" onclick={() => (open = false)}>{$_("menuChangelog")}</a>
      <a href="#" onclick={() => (open = false)}>{$_("menuRoadmap")}</a>
      <a href="#" onclick={() => (open = false)}>{$_("menuContact")}</a>
      <a href="#" onclick={() => (open = false)}>{$_("menuDonate")}</a>
      <a
        href="#"
        onclick={(e) => {
          e.preventDefault();
          handleLogout();
        }}
      >
        {$_("menuLogout")}
      </a>
    </div>
  </div>
</div>
