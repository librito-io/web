<script lang="ts">
  import { _ } from "$lib/i18n";
  import { enhance } from "$app/forms";

  type ActionResult = { ok?: boolean; error?: string } | null;
  let { form }: { form: ActionResult } = $props();

  let submitting = $state(false);
</script>

<svelte:head>
  <title>Support · Librito</title>
</svelte:head>

<section class="support">
  <h1>{$_("supportHeading")}</h1>
  <p class="intro">{$_("supportIntro")}</p>

  {#if form?.ok}
    <p class="success" role="status">{$_("supportFormSuccess")}</p>
  {:else}
    <form
      method="POST"
      action="?/contact"
      use:enhance={() => {
        submitting = true;
        return async ({ update }) => {
          await update();
          submitting = false;
        };
      }}
    >
      <!-- Honeypot: hidden from humans, tempting to bots. Server drops any
           submission where this is non-empty. -->
      <input
        class="hp"
        type="text"
        name="company"
        tabindex="-1"
        autocomplete="off"
        aria-hidden="true"
      />

      <label for="support-email">{$_("supportFormEmail")}</label>
      <input id="support-email" name="email" type="email" required />

      <label for="support-message">{$_("supportFormMessage")}</label>
      <textarea id="support-message" name="message" rows="6" required
      ></textarea>

      {#if form?.error}
        <p class="error" role="alert">{form.error}</p>
      {/if}

      <button type="submit" disabled={submitting}>
        {submitting ? $_("supportFormSending") : $_("supportFormSubmit")}
      </button>
    </form>

    <p class="fallback">
      {$_("supportEmailFallbackPrefix")}
      <a href="mailto:support@librito.io">support@librito.io</a>
    </p>
  {/if}
</section>

<style>
  .support {
    max-width: 42rem;
    margin: 3rem auto;
    padding: 0 1.25rem;
  }
  h1 {
    font-size: 2rem;
    margin-bottom: 0.75rem;
  }
  .intro {
    color: #c9c9c9;
    line-height: 1.6;
    margin-bottom: 2rem;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    font-weight: 600;
    margin-top: 0.75rem;
  }
  input[type="email"],
  textarea {
    background: #1b1e22;
    border: 1px solid #33373d;
    border-radius: 8px;
    color: #ededed;
    padding: 0.65rem 0.75rem;
    font: inherit;
  }
  /* Honeypot: removed from the visual + a11y tree, still in the DOM for bots. */
  .hp {
    position: absolute;
    left: -9999px;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  button {
    margin-top: 1.25rem;
    align-self: flex-start;
    background: #dedede;
    color: #15171a;
    border: none;
    border-radius: 999px;
    padding: 0.7rem 1.75rem;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .success {
    color: #7bd88f;
    font-size: 1.1rem;
  }
  .error {
    color: #ff6b6b;
  }
  .fallback {
    margin-top: 2rem;
    color: #9a9a9a;
  }
  .fallback a {
    color: #4aa3ff;
  }
</style>
