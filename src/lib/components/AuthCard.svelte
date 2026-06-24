<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    children,
    heading = "Librito",
  }: { children: Snippet; heading?: string } = $props();
</script>

<div class="auth-card">
  <span class="wordmark">{heading}</span>
  {@render children()}
</div>

<style>
  .auth-card {
    max-width: 400px;
    margin: 80px auto;
    padding: 40px 32px;
    background: #0f1013;
    border: 1px solid #2a2a2a;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .wordmark {
    text-align: center;
    font-size: 1.5rem;
    font-weight: 700;
    color: #e8e8e8;
    letter-spacing: 0.02em;
  }
  /* Shared child styles. :global so slotted page markup is styled, scoped
     under .auth-card so nothing leaks app-wide. Pages use these class names. */
  .auth-card :global(h1) {
    color: #e8e8e8;
    font-size: 1.25rem;
    margin: 0;
    text-align: center;
  }
  .auth-card :global(.divider) {
    display: flex;
    align-items: center;
    color: #888a90;
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
    gap: 4px;
    color: #f8f8f8;
    font-size: 0.9rem;
    text-align: left;
  }
  .auth-card :global(input) {
    height: 48px;
    padding: 10px 12px;
    background: #15171a;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    color: #e8e8e8;
    font-family: inherit;
    font-size: 1rem;
  }
  .auth-card :global(.primary) {
    padding: 10px 24px;
    background: #f8f8f8;
    color: #15171a;
    border: 1px solid #f8f8f8;
    border-radius: 999px;
    font-family: inherit;
    font-size: 0.95rem;
    cursor: pointer;
  }
  .auth-card :global(.primary:disabled) {
    opacity: 0.5;
  }
  .auth-card :global(.secondary) {
    background: #2a2a2a;
    color: #e8e8e8;
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
    color: #888a90;
    font-size: 0.9rem;
    text-align: center;
  }
  .auth-card :global(.footer a) {
    color: #e8e8e8;
    text-decoration: underline;
  }
</style>
