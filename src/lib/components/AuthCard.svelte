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
    max-width: 400px;
    margin: 80px auto;
    padding: 40px 32px;
    background: #0f1114;
    border: 1px solid #242629;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    transition: border-color var(--dur-2) var(--ease-hover);
  }
  .auth-card:hover {
    border-color: #47494b;
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
    font-size: 0.85rem;
  }
  .auth-card :global(.divider)::before,
  .auth-card :global(.divider)::after {
    content: "";
    flex: 1;
    height: 1px;
    background: #2a2a2a;
  }
  .auth-card :global(.divider span) {
    padding: 0 12px;
  }
  .auth-card :global(form) {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .auth-card :global(label) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: #dedede;
    font-size: 0.9rem;
    font-weight: 500;
    text-align: left;
  }
  .auth-card :global(input) {
    height: 48px;
    padding: 10px 12px;
    background: #16181b;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    color: #dedede;
    font-family: inherit;
    font-size: 1rem;
    /* Keep typed text at the normal weight; the label above is 500. */
    font-weight: 400;
  }
  .auth-card :global(.primary) {
    /* Extra breathing room before the CTA: 18px + the form's 14px flex gap
       = 32px between the last field and the submit button. */
    margin-top: 18px;
    height: 48px;
    padding: 10px 24px;
    background: #dedede;
    color: #15171a;
    border: 1px solid #dedede;
    border-radius: 999px;
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
  }
  .auth-card :global(.primary:disabled) {
    opacity: 0.5;
  }
  .auth-card :global(.secondary) {
    background: #2a2a2a;
    color: #dedede;
    border: 1px solid #3a3a3a;
    border-radius: 999px;
    padding: 10px 24px;
    font-family: inherit;
    font-size: 0.95rem;
    cursor: pointer;
  }
  .auth-card :global(.secondary:disabled) {
    opacity: 0.5;
  }
  .auth-card :global(.auth-error) {
    color: #c44;
    font-size: 0.9rem;
    margin: 0;
  }
  .auth-card :global(.auth-msg) {
    color: #ccc;
    font-size: 0.95rem;
    line-height: 1.6;
    margin: 0;
  }
  .auth-card :global(.hint) {
    color: #888;
    font-size: 0.9rem;
    margin: 0;
  }
  .auth-card :global(.footer) {
    color: #8b8f95;
    font-size: 0.9rem;
    text-align: center;
  }
  .auth-card :global(.footer a) {
    color: #dedede;
    text-decoration: none;
    font-weight: 500;
  }
</style>
