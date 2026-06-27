<div class="logo-placeholder">
  <img src="/librito.svg" alt="Librito" />
</div>

<style>
  /* Placeholder homepage: center the wordmark in the viewport below the
     sticky site header (~80px). Swap to real content when the landing
     page ships. */
  .logo-placeholder {
    min-height: calc(100svh - 81px);
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .logo-placeholder img {
    width: min(544px, 70vw);
    height: auto;
    transform: translateY(-100px);
    /* Same "lift toward light" as the auth buttons (#dedede → #fff). The
       wordmark fill is flat #dedede, so brightness(1.15) maps it to pure
       #fff — matches the color target without inlining the SVG. Slower than
       the shared --dur-2 hover (180ms): this is a hero element, so the
       brighten should glide, not snap. --ease-in-out (not --ease-out) so the
       change spreads across the whole duration — a front-loaded ease-out
       finishes ~90% in the first ~110ms and makes the duration imperceptible.
       Duration is inline because the longest shared token (--dur-3) is only
       240ms.

       Asymmetric: this base-state transition governs the hover-OUT, given a
       longer 1000ms with --ease-in-out for an even, smooth dim back to
       #dedede. The hover-IN is the shorter 560ms set on :hover below. */
    transition: filter 1000ms var(--ease-in-out);
  }
  .logo-placeholder img:hover {
    filter: brightness(1.15);
    /* Hover-IN: shorter than the 1000ms hover-out for an asymmetric feel —
       brighten arrives, then dims back evenly and slowly. */
    transition: filter 560ms var(--ease-in-out);
  }

  /* The -100px lift is tuned for desktop; on a shorter phone viewport the
     same offset reads as too high. Ease it to -40px (near-centred, slight
     lift) below the mobile breakpoint. */
  @media (max-width: 599px) {
    .logo-placeholder img {
      transform: translateY(-40px);
    }
  }
</style>
