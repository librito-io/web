<script lang="ts">
  import { _ } from "$lib/i18n";

  // Floating primary CTA. Fixed to the viewport bottom-right so it stays
  // put as the user scrolls and persists across route navigations (rendered
  // once in the root layout, not per-page). Links to signup by default.
  let { href = "/auth/signup" }: { href?: string } = $props();
</script>

<a class="fab" {href}>{$_("landingGetStarted")}</a>

<style>
  .fab {
    position: fixed;
    right: 48px;
    bottom: 48px;
    /* Below the sticky header (z 60) and any future modal/overlay, above
       page content. */
    z-index: 40;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 12px 32px;
    border-radius: 999px;
    background: #087fe8;
    color: #fff;
    font-size: 1.25rem;
    font-weight: 600;
    text-decoration: none;
    /* Lift off the content it floats over. */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    transition: filter var(--dur-2) var(--ease-hover);
  }
  .fab:hover {
    filter: brightness(1.1);
  }

  @media (max-width: 599px) {
    .fab {
      right: 16px;
      bottom: 16px;
      font-size: 1.125rem;
      padding: 10px 24px;
    }
  }
</style>
