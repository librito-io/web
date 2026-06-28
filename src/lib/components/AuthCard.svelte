<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    children,
    heading = "Librito",
  }: { children: Snippet; heading?: string | null } = $props();
</script>

<div class="auth-card">
  <!-- Brand wordmark (span, not a heading). Pages whose primary heading IS
       the card title pass heading={null} and render their own <h2> instead
       (the site header already owns the page <h1>). -->
  {#if heading}
    <span class="wordmark">{heading}</span>
  {/if}
  {@render children()}
</div>

<style>
  .auth-card {
    max-width: 448px;
    margin: 184px auto 80px;
    padding: 48px;
    background: #0f1114;
    border: 1px solid #232629;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    transition: border-color var(--dur-2) var(--ease-hover);
  }
  .auth-card:hover {
    border-color: #47494b;
  }
  /* Mobile: drop the modal chrome. A bordered card cramps a phone viewport,
     so the auth elements sit directly on the page background (the inputs +
     OAuth buttons keep their own #16181b fill for contrast). */
  @media (max-width: 480px) {
    .auth-card {
      margin: 72px auto 48px;
      padding: 8px 20px 24px;
      background: transparent;
      border: none;
      border-radius: 0;
    }
    .auth-card:hover {
      border-color: transparent;
    }
  }
  .wordmark {
    text-align: center;
    font-size: 1.5rem;
    font-weight: 700;
    color: #dedede;
    letter-spacing: 0.02em;
  }
  /* Shared child styles. :global so slotted page markup is styled, scoped
     under .auth-card so nothing leaks app-wide. Pages use these class names. */
  .auth-card :global(h1) {
    color: #dedede;
    font-size: 1.25rem;
    margin: 0;
    text-align: center;
  }
  .auth-card :global(.divider) {
    display: flex;
    align-items: center;
    color: #8b8f95;
    /* sm scale token (was an off-scale 0.85rem). */
    font-size: 0.875rem;
  }
  .auth-card :global(.divider)::before,
  .auth-card :global(.divider)::after {
    content: "";
    flex: 1;
    height: 1px;
    /* Match the card's resting outline so the hairlines are unified. */
    background: #232629;
  }
  .auth-card :global(.divider span) {
    padding: 0 12px;
  }
  .auth-card :global(form) {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  /* Independent knob for the username↔password gap only. The form gap (16px)
     governs every field pair incl. password↔button; this margin stacks on top
     of the gap for the first field so that one gap can be tuned without
     touching the password↔button spacing (which also carries .primary's
     margin-top). 16 gap + 8 = 24px. */
  .auth-card :global(form > label) {
    margin-bottom: 8px;
  }
  .auth-card :global(label) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: #dedede;
    font-size: 0.875rem;
    font-weight: 500;
    /* `start` (not `left`) so labels hug the inline-start edge in RTL (ar). */
    text-align: start;
  }
  .auth-card :global(input) {
    height: 48px;
    padding: 12px 16px;
    background: #16181b;
    /* No resting outline — the field is defined by its fill; the border only
       appears on focus (#dedede). 1px transparent keeps the box size stable so
       focus adds no layout shift. (A hover border was tried and dropped —
       focus is the only input affordance, by choice.) */
    border: 1px solid transparent;
    border-radius: 8px;
    color: #dedede;
    font-family: inherit;
    font-size: 1rem;
    /* Keep typed text at the normal weight; the label above is 500. */
    font-weight: 400;
    /* Smooth the focus border fade-in. */
    transition: border-color var(--dur-2) var(--ease-hover);
  }
  /* Replace the UA blue focus ring with an on-brand indicator (brighter
     border) — keeps a visible focus state for keyboard a11y, no layout shift. */
  .auth-card :global(input:focus) {
    outline: none;
    border-color: #dedede;
  }
  /* Placeholder doubles as the field label (the <label> is visually hidden).
     Mid-grey from the palette, clearly dimmer than the #dedede typed text;
     opacity:1 overrides Firefox's default placeholder dimming. */
  .auth-card :global(input)::placeholder {
    color: #6f7479;
    opacity: 1;
  }
  /* Browsers paint a pale-yellow background on autofilled fields and ignore
     background-color. Mask it with an inset box-shadow in the field colour and
     pin the text fill so an autofilled field looks identical to an empty one. */
  .auth-card :global(input:-webkit-autofill),
  .auth-card :global(input:-webkit-autofill:hover),
  .auth-card :global(input:-webkit-autofill:focus) {
    -webkit-box-shadow: 0 0 0 1000px #16181b inset;
    box-shadow: 0 0 0 1000px #16181b inset;
    -webkit-text-fill-color: #dedede;
    caret-color: #dedede;
  }
  .auth-card :global(.primary) {
    /* Extra breathing room before the CTA: 16px + the form's 16px flex gap
       = 32px between the last field and the submit button. */
    margin-top: 16px;
    height: 48px;
    padding: 12px 24px;
    background: #dedede;
    color: #15171a;
    border: 1px solid #dedede;
    border-radius: 999px;
    font-family: inherit;
    font-size: 1.125rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color var(--dur-2) var(--ease-hover),
      border-color var(--dur-2) var(--ease-hover);
  }
  /* The OAuth buttons lift toward light on hover; this off-white CTA has the
     same headroom, so it brightens to pure #fff — one "hover = lift toward
     light" model across every button. :not(:disabled) leaves the loading
     state (opacity 0.5) alone. */
  /* Guard hover behind a real pointer — on touch, :hover sticks after a tap
     until the user taps elsewhere (sticky-hover). */
  @media (hover: hover) and (pointer: fine) {
    .auth-card :global(.primary:not(:disabled):hover) {
      background: #fff;
      border-color: #fff;
    }
  }
  .auth-card :global(.primary:disabled) {
    opacity: 0.5;
  }
  .auth-card :global(.secondary) {
    background: #2a2a2a;
    color: #dedede;
    border: 1px solid #3a3a3a;
    border-radius: 999px;
    padding: 12px 24px;
    font-family: inherit;
    font-size: 1rem;
    cursor: pointer;
  }
  .auth-card :global(.secondary:disabled) {
    opacity: 0.5;
  }
  .auth-card :global(.auth-error) {
    color: #c44;
    font-size: 0.875rem;
    margin: 0;
  }
  .auth-card :global(.auth-msg) {
    color: #dedede;
    font-size: 1.125rem;
    font-weight: 500;
    line-height: 1.6;
    /* Extra room below the notice before the footer link; stacks on the
       card's 24px flex gap. */
    margin: 0 0 24px;
    /* Cap the measure so the message wraps into a tidy block instead of
       stretching the full card width into a lopsided two-liner. align-self
       centres the narrowed block in the flex column; the lines are
       left-aligned within it. */
    max-width: 22ch;
    align-self: center;
    text-align: left;
  }
  .auth-card :global(.hint) {
    color: #888;
    font-size: 0.875rem;
    margin: 0;
  }
  .auth-card :global(.footer) {
    color: #8b8f95;
    font-size: 0.875rem;
    text-align: center;
  }
  .auth-card :global(.footer a) {
    color: #dedede;
    text-decoration: none;
    font-weight: 500;
    transition: color var(--dur-2) var(--ease-hover);
    /* Suppress the iOS long-press callout on the switch-mode links. */
    -webkit-touch-callout: none;
  }
  /* Same "lift toward light" as the buttons (#dedede → #fff), on the link's
     text color. Covers both footer links — "Sign up" (login) and "Log in"
     (signup). */
  @media (hover: hover) and (pointer: fine) {
    .auth-card :global(.footer a:hover) {
      color: #fff;
    }
  }
</style>
