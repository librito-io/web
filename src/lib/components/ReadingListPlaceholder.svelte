<script lang="ts">
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { _ } from "$lib/i18n";
  import { DURATION } from "$lib/motion";

  // Entrance uses the motion language: decelerate (cubicOut ≈ --ease-out)
  // over the entrance duration (--dur-4). A small rise + fade — restrained,
  // not decorative.
</script>

<div
  class="placeholder"
  in:fly={{ y: 8, duration: DURATION.d4, easing: cubicOut }}
>
  <svg
    class="glyph"
    width="40"
    height="40"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M6 4h11a2 2 0 0 1 2 2v14l-4-2.5L11 20V6a2 2 0 0 0-2-2H6Z" />
    <path d="M6 4a2 2 0 0 0-2 2v12" />
  </svg>
  <h2 class="title">{$_("readingList")}</h2>
  <p class="sub">{$_("readingListComingSoon")}</p>
</div>

<style>
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 10px;
    padding: 88px 20px 120px;
    color: #6f7479;
  }

  .glyph {
    color: #44494e;
    margin-bottom: 4px;
  }

  .title {
    font-family: inherit;
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: var(--tracking-lg);
    color: #c9cdd2;
  }

  .sub {
    font-size: 0.9rem;
    letter-spacing: var(--tracking-sm);
    color: #6f7479;
  }
</style>
