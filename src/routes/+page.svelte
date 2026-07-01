<script lang="ts">
  import { _ } from "$lib/i18n";
</script>

<section class="hero">
  <img class="wordmark" src="/librito.svg" alt="Librito" />
  <!-- Tagline carries a <mark> around "highlights," — a literal nod to the
       product. Rendered via {@html} because the marked span lives inside the
       localized string (so each locale can mark its own equivalent word).
       Source is our own translation files, never user input. -->
  <p class="tagline">{@html $_("landingTagline")}</p>
  <a class="cta" href="/auth/signup">{$_("landingGetStarted")}</a>
</section>

<style>
  /* Landing hero: a left-aligned editorial block (wordmark, tagline, CTA all
     sharing one left gutter), vertically centered in the viewport below the
     sticky site header (~81px). */
  .hero {
    min-height: calc(100svh - 81px);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    /* Top-anchored, NOT centered: the top padding parks the wordmark at the
       same spot a centered block sat (50svh minus a constant), but because the
       block now grows downward from a fixed top, increasing any inner gap
       pushes the tagline + CTA DOWN while the wordmark stays put. The 308px
       constant reproduces the previous centered+(-48px lift) position; raise it
       to move the whole block up, lower it to move down. */
    justify-content: flex-start;
    /* Vertical rhythm is set by each child's margin-top (see .tagline / .cta)
       rather than a shared `gap`, so the wordmark↔tagline and tagline↔CTA
       spacing read as direct values instead of gap-plus-margin arithmetic. */
    /* Cap the block width and center it so on ultrawide / fullscreen it drifts
       toward the middle instead of gluing to a fixed left gutter (which left a
       huge void on the right). Sized so a normal laptop keeps roughly the same
       left indent (~100px @ 1280) while a 2560px screen centers the block. */
    width: 100%;
    max-width: 1120px;
    margin-inline: auto;
    padding: max(24px, calc(50svh - 308px)) 24px 24px;
  }

  .wordmark {
    width: min(480px, 80vw);
    height: auto;
    /* The librito.svg carries ~1.7% transparent whitespace on its left, so the
       painted "L" sits inset from the image box. Shift left to cancel it, so
       the "L" ink aligns with the "T" of "The" below (measured: 7px @ 512w).
       Percentage of own width keeps it proportional as the wordmark scales. */
    transform: translateX(-1.37%);
    /* Same "lift toward light" as the header wordmark + auth CTA (#dedede →
       #fff): the flat #dedede fill maps to pure white at brightness(1.15).
       Asymmetric like the old placeholder — slow even dim-back on hover-out
       (1000ms), shorter brighten on hover-in (560ms). */
    transition: filter 1000ms var(--ease-in-out);
  }
  .wordmark:hover {
    filter: brightness(1.15);
    transition: filter 560ms var(--ease-in-out);
  }

  .tagline {
    /* Gap from the wordmark above. */
    margin: 64px 0 0;
    max-width: 18em;
    text-align: left;
    /* Honor newlines embedded in the localized string (so each locale
       picks its own grammatical break) while still soft-wrapping long
       translations against max-width. English breaks after "your". */
    white-space: pre-line;
    color: #ededed;
    font-size: 32px;
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: -0.01em;
  }
  /* CJK has no spaces and wraps per character, so the 18em Latin measure
     forced an ugly 2–3 character orphan tail ("な場所。" / "之地。"). The copy
     is short — let it size to content (bounded by the hero block / viewport)
     so it sits on one line on desktop and wraps cleanly at the edge on mobile. */
  .tagline:lang(ja),
  .tagline:lang(zh),
  .tagline:lang(ko) {
    max-width: none;
    /* The base -0.01em tracking is Latin display type; on full-width CJK
       glyphs it reads cramped, especially at this bold weight. Open it up with
       display-heading tracking so the characters breathe. */
    letter-spacing: 0.1em;
  }
  /* Highlighter marker on "highlights," — brand blue, rounded, with a little
     breathing room left/right. box-decoration-break: clone keeps the padding
     + radius intact if the span ever wraps across lines. */
  .tagline :global(mark) {
    background: #006fce;
    color: #f5f5f5;
    border-radius: 4px;
    /* Asymmetric padding (T R B L): the trailing comma's side-bearing makes
       the right edge read as over-padded, so trim right vs left. Extra bottom
       room clears the "g"/"y" descenders. */
    padding: 0.03em 0.1em 0.13em 0.2em;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  /* The ja/zh marks end in an ideographic comma "、" whose glyph carries a huge
     ~0.66em trailing bearing, so the blue box read as heavily over-padded on
     the right vs the Latin marks. (padding-right can't be negative — CSS
     ignores it — so instead the comma is wrapped in .cjk-sep and pulled in with
     a negative margin, which shrinks the mark's content box to hug the comma
     ink.) The mark then gets an equal positive margin-right so the following
     text keeps its natural spacing after the comma. Korean uses a regular
     ASCII-width comma, so it's excluded. */
  .tagline :global(.cjk-sep) {
    margin-right: -0.66em;
  }
  .tagline:lang(ja) :global(mark),
  .tagline:lang(zh) :global(mark) {
    margin-right: 0.66em;
  }

  /* Light primary CTA — the auth-form .primary treatment (#dedede on dark),
     lifting toward #fff on hover. Inline + static, left-aligned under the
     tagline with extra space above it. */
  .cta {
    /* Gap from the tagline above. */
    margin-top: 96px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 12px 32px;
    border-radius: 999px;
    background: #dedede;
    color: #15171a;
    font-size: 1.5rem;
    font-weight: 600;
    text-decoration: none;
    transition: filter var(--dur-2) var(--ease-hover);
  }
  .cta:hover {
    filter: brightness(1.08);
  }

  /* On a phone the wide editorial gutter wastes space — tighten to a normal
     page margin and ease the lift; the taller stacked block sits near center. */
  @media (max-width: 599px) {
    .hero {
      /* Phone: revert to simple vertical centering (the desktop top-anchor
         math isn't needed on a short viewport). */
      justify-content: center;
      /* Slightly wider side gutter than the desktop block (32 vs 24). */
      padding: 24px 32px;
      transform: translateY(-8px);
    }
    .wordmark {
      /* Narrower on a phone than the desktop 80vw — matches the prior 70vw. */
      width: 70vw;
    }
    .tagline {
      /* Tighter vertical rhythm on a phone than the desktop 64/96. */
      margin-top: 48px;
      font-size: 1.5rem;
      /* A touch more leading than the desktop 1.4 — the narrower measure wraps
         to more lines, so the extra line spacing reads better on a phone. */
      line-height: 1.5;
      /* Collapse the desktop \n back to a space and wrap naturally. The lone
         "lists." orphan is prevented engine-independently by the non-breaking
         space binding "reading lists." in the localized string — text-wrap:
         balance was a no-op in WebKit (the inline <mark> disables it), so
         relying on it would make Chrome and Safari wrap differently. */
      white-space: normal;
    }
    /* The 1.5rem / 36px desktop CTA is oversized on a phone — scale back. */
    .cta {
      margin-top: 64px;
      font-size: 1.125rem;
      padding: 12px 32px;
    }
  }
</style>
