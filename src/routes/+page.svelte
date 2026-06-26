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
       #fff — matches the color target without inlining the SVG. */
    transition: filter var(--dur-2) var(--ease-hover);
  }
  .logo-placeholder img:hover {
    filter: brightness(1.15);
  }
</style>
